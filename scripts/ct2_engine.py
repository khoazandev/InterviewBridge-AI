#!/usr/bin/env python3
"""GPU-accelerated CTranslate2 ASR (faster-whisper) + En->Vi Translator (NLLB-200) micro-engine."""

from __future__ import annotations

import argparse
from functools import lru_cache
import importlib.util
import io
import json
import os
from pathlib import Path
import platform
import re
import struct
import sys
import threading
import time
import wave

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def _register_nvidia_dlls() -> None:
    """Register pip-installed NVIDIA CUDA 12 DLL directories before importing ctranslate2 on Windows."""
    if os.name != "nt":
        return
    for pkg_name in ("nvidia.cublas", "nvidia.cudnn", "nvidia.cuda_nvrtc"):
        spec = importlib.util.find_spec(pkg_name)
        if spec and spec.submodule_search_locations:
            for loc in spec.submodule_search_locations:
                bin_dir = Path(loc) / "bin"
                if bin_dir.is_dir():
                    os.environ["PATH"] = str(bin_dir) + os.pathsep + os.environ.get("PATH", "")
                    if hasattr(os, "add_dll_directory"):
                        os.add_dll_directory(str(bin_dir))


_register_nvidia_dlls()

import ctranslate2  # noqa: E402
from fastapi import FastAPI, File, Request, UploadFile  # noqa: E402
from faster_whisper import WhisperModel  # noqa: E402
from huggingface_hub import snapshot_download  # noqa: E402
import numpy as np  # noqa: E402
import sentencepiece as spm  # noqa: E402
import uvicorn  # noqa: E402

ASR_MODEL_ID = os.environ.get("CT2_ASR_MODEL", "Systran/faster-whisper-small.en")
MT_MODEL_ID = os.environ.get("CT2_MT_MODEL", "JustFrederik/nllb-200-distilled-600M-ct2-int8")
DEFAULT_HOTWORDS = (
    "Interview conversation. Terms: TikTok, Platform Responsibility, AI Model Reinforcement, "
    "Trust and Safety, HUTECH, YOOT Edu, AdsAgency, SmartHire, Gemini SDK, rubric, JSON schema, edge cases."
)

IDIOM_RULES: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"\bwalk me through\b", re.IGNORECASE), "give me a brief overview of"),
    (re.compile(r"\bwalk us through\b", re.IGNORECASE), "give us a brief overview of"),
    (
        re.compile(r"\btell me (?:a little bit |a bit )?about yourself\b", re.IGNORECASE),
        "briefly introduce yourself and your background",
    ),
    (
        re.compile(r"\bwhat(?:'s| is) your notice period\b", re.IGNORECASE),
        "how many days after receiving an offer can you start working",
    ),
    (re.compile(r"\bnotice period\b", re.IGNORECASE), "waiting days before starting the new job"),
    (re.compile(r"\bedge cases\b", re.IGNORECASE), "rare special cases"),
    (re.compile(r"\bedge case\b", re.IGNORECASE), "rare special case"),
    (re.compile(r"\bcorner cases\b", re.IGNORECASE), "rare special cases"),
    (re.compile(r"\bculture fit\b", re.IGNORECASE), "compatibility with the team culture"),
    (re.compile(r"\bcompensation package\b", re.IGNORECASE), "total salary and benefits package"),
    (re.compile(r"\bonboarding\b", re.IGNORECASE), "joining and integrating into the team"),
    (re.compile(r"\btrade-?offs\b", re.IGNORECASE), "pros and cons"),
)

_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")
_PREF_CACHE: dict[str, object] = {"mtime": -1.0, "prompt": DEFAULT_HOTWORDS}


def normalize_interview_english(text: str) -> str:
    """Rewrite common HR/Tech spoken idioms so NLLB-200 produces natural Vietnamese."""
    cleaned = text.replace("🔤", "").strip()
    cleaned = re.sub(r"\s+", " ", cleaned)
    for pattern, replacement in IDIOM_RULES:
        cleaned = pattern.sub(replacement, cleaned)
    return cleaned


def _get_preferences_path() -> Path:
    system = platform.system().lower()
    if system == "windows":
        return Path.home() / "AppData" / "Roaming" / "interview-bridge-config" / "preferences.json"
    if system == "darwin":
        return Path.home() / "Library" / "Application Support" / "interview-bridge-config" / "preferences.json"
    return Path.home() / ".config" / "interview-bridge-config" / "preferences.json"


def get_domain_hotwords_prompt() -> str:
    """Load compact (<220 char) Whisper initial_prompt from synced CV/JD preferences."""
    prefs_path = _get_preferences_path()
    try:
        if prefs_path.exists():
            mtime = prefs_path.stat().st_mtime
            if mtime != _PREF_CACHE["mtime"]:
                prefs = json.loads(prefs_path.read_text(encoding="utf-8"))
                role = str(prefs.get("hrRole") or "").strip()
                cv_text = str(prefs.get("cvText") or "")
                jd_text = str(prefs.get("jdText") or "")
                keywords: list[str] = []
                if role:
                    keywords.append(role.split("@")[0].strip())
                for term in (
                    "TikTok",
                    "Platform Responsibility",
                    "Model Reinforcement",
                    "HUTECH",
                    "YOOT Edu",
                    "AdsAgency",
                    "SmartHire",
                    "IELTS",
                    "Gemini",
                    "React",
                    "Next.js",
                    "TypeScript",
                    "FastAPI",
                    "Python",
                    "rubric",
                    "edge cases",
                ):
                    if term.lower() in cv_text.lower() or term.lower() in jd_text.lower() or term.lower() in role.lower():
                        keywords.append(term)
                prompt = f"Interview dialogue. Context: {', '.join(dict.fromkeys(keywords))}" if keywords else DEFAULT_HOTWORDS
                _PREF_CACHE["mtime"] = mtime
                _PREF_CACHE["prompt"] = prompt[:215]
    except Exception:
        pass
    return str(_PREF_CACHE["prompt"])


class CT2Engine:
    """Thread-safe GPU/CPU inference engine combining faster-whisper and NLLB-200."""

    def __init__(self) -> None:
        self.device = "cpu"
        self.compute_type = "int8"
        self._asr_lock = threading.Lock()
        self._mt_lock = threading.Lock()
        self.whisper: WhisperModel
        self.translator: ctranslate2.Translator
        self.sp: spm.SentencePieceProcessor
        self._load_models()

    def _load_models(self) -> None:
        nllb_dir = snapshot_download(MT_MODEL_ID)
        sp_path = str(Path(nllb_dir) / "sentencepiece.bpe.model")
        self.sp = spm.SentencePieceProcessor(sp_path)

        has_cuda = False
        try:
            has_cuda = ctranslate2.get_cuda_device_count() > 0
        except Exception:
            has_cuda = False

        candidates = [("cuda", "int8_float16"), ("cpu", "int8")] if has_cuda else [("cpu", "int8")]
        last_err: Exception | None = None
        for dev, ctype in candidates:
            try:
                translator = ctranslate2.Translator(nllb_dir, device=dev, compute_type=ctype)
                whisper = WhisperModel(ASR_MODEL_ID, device=dev, compute_type=ctype)
                # Warm up CUDA/CPU kernels for both translation and Whisper before first live question
                translator.translate_batch([["eng_Latn", "▁Hello", "</s>"]], target_prefix=[["vie_Latn"]], beam_size=1)
                warmup_segments, _ = whisper.transcribe(
                    np.zeros(8000, dtype=np.float32),
                    language="en",
                    beam_size=1,
                    vad_filter=False,
                    without_timestamps=True,
                )
                list(warmup_segments)
                self.device = dev
                self.compute_type = ctype
                self.translator = translator
                self.whisper = whisper
                return
            except Exception as exc:
                last_err = exc
                print(f"[ct2_engine] Failed initializing on {dev} ({ctype}): {exc}", file=sys.stderr)
        raise RuntimeError(f"Could not initialize CTranslate2 models: {last_err}")

    @lru_cache(maxsize=512)
    def translate_en_to_vi(self, text: str) -> str:
        normalized = normalize_interview_english(text)
        if not normalized:
            return ""
        sentences = [s.strip() for s in _SENTENCE_SPLIT_RE.split(normalized) if s.strip()]
        if not sentences:
            sentences = [normalized]

        batch_tokens = [["eng_Latn"] + self.sp.encode_as_pieces(sent) + ["</s>"] for sent in sentences]
        prefixes = [["vie_Latn"]] * len(batch_tokens)

        with self._mt_lock:
            results = self.translator.translate_batch(
                batch_tokens,
                target_prefix=prefixes,
                beam_size=1,
                max_decoding_length=256,
            )

        out_sentences: list[str] = []
        skip_tokens = {"vie_Latn", "eng_Latn", "</s>", "<s>", "<pad>"}
        for res in results:
            tokens = [tok for tok in res.hypotheses[0] if tok not in skip_tokens]
            decoded = self.sp.decode_pieces(tokens).strip()
            if decoded:
                out_sentences.append(decoded)
        return " ".join(out_sentences).strip()

    @staticmethod
    def _decode_audio_input(wav_bytes: bytes):
        """Decode PCM WAV bytes directly into float32 numpy audio (bypasses PyAV version mismatches)."""
        if wav_bytes[:4] == b"RIFF" and wav_bytes[8:12] == b"WAVE":
            with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
                channels = wf.getnchannels()
                sample_width = wf.getsampwidth()
                sample_rate = wf.getframerate()
                frames = wf.readframes(wf.getnframes())
            if sample_width == 2:
                samples = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
                if channels > 1:
                    samples = samples.reshape(-1, channels).mean(axis=1)
                if sample_rate == 16000:
                    return samples
                target_len = max(1, int(round(len(samples) * 16000 / sample_rate)))
                x_old = np.linspace(0.0, 1.0, num=len(samples), endpoint=False)
                x_new = np.linspace(0.0, 1.0, num=target_len, endpoint=False)
                return np.interp(x_new, x_old, samples).astype(np.float32)
        return io.BytesIO(wav_bytes)

    def transcribe_and_translate(self, wav_bytes: bytes) -> dict[str, object]:
        started = time.perf_counter()
        prompt = get_domain_hotwords_prompt()
        audio_input = self._decode_audio_input(wav_bytes)
        rms = 1.0
        duration_s = 0.0
        if isinstance(audio_input, np.ndarray):
            duration_s = audio_input.size / 16000.0
            rms = float(np.sqrt(np.mean(np.square(audio_input)))) if audio_input.size else 0.0
            if rms < 0.002:
                return {
                    "text": "",
                    "vi_text": "",
                    "device": self.device,
                    "latency_ms": round((time.perf_counter() - started) * 1000.0, 1),
                }
        with self._asr_lock:
            segments, _ = self.whisper.transcribe(
                audio_input,
                language="en",
                beam_size=1,
                vad_filter=False,
                without_timestamps=True,
                condition_on_previous_text=False,
                initial_prompt=prompt,
            )
            en_text = " ".join(seg.text.strip() for seg in segments if seg.text and seg.text.strip()).strip()
        if duration_s < 1.3 and rms < 0.006 and en_text.lower().strip(" .,!?") in {"you", "thank you", "thanks for watching", "bye"}:
            en_text = ""
        vi_text = self.translate_en_to_vi(en_text) if en_text else ""
        elapsed_ms = round((time.perf_counter() - started) * 1000.0, 1)
        return {
            "text": en_text,
            "vi_text": vi_text,
            "device": self.device,
            "latency_ms": elapsed_ms,
        }


_ENGINE: CT2Engine | None = None
_ENGINE_LOCK = threading.Lock()


def get_engine() -> CT2Engine:
    global _ENGINE
    if _ENGINE is None:
        with _ENGINE_LOCK:
            if _ENGINE is None:
                _ENGINE = CT2Engine()
    return _ENGINE


app = FastAPI(title="InterviewBridge CTranslate2 Engine")


@app.get("/")
@app.get("/health")
def health() -> dict[str, str]:
    eng = get_engine()
    return {
        "status": "ok",
        "device": eng.device,
        "compute_type": eng.compute_type,
        "asr_model": ASR_MODEL_ID,
        "mt_model": MT_MODEL_ID,
    }


@app.post("/translate")
async def translate_endpoint(request: Request) -> dict[str, object]:
    payload = await request.json()
    raw_text = str(payload.get("text") or payload.get("q") or "").strip()
    if not raw_text:
        return {"result": "", "translatedText": "", "latency_ms": 0.0}
    eng = get_engine()
    started = time.perf_counter()
    vi_text = eng.translate_en_to_vi(raw_text)
    elapsed_ms = round((time.perf_counter() - started) * 1000.0, 1)
    return {
        "result": vi_text,
        "translatedText": vi_text,
        "device": eng.device,
        "latency_ms": elapsed_ms,
    }


@app.post("/inference")
async def inference_endpoint(file: UploadFile = File(...)) -> dict[str, object]:
    wav_bytes = await file.read()
    eng = get_engine()
    return eng.transcribe_and_translate(wav_bytes)


def run_self_test() -> None:
    eng = get_engine()
    print(f"Engine initialized: device={eng.device}, compute_type={eng.compute_type}")

    sample = "Walk me through your resume. What is your notice period? How do you handle edge cases?"
    t0 = time.perf_counter()
    vi = eng.translate_en_to_vi(sample)
    mt_ms = round((time.perf_counter() - t0) * 1000.0, 1)
    print(f"MT ({mt_ms} ms): {sample} -> {vi}")
    assert vi and "<unk>" not in vi and "vie_Latn" not in vi, f"Unexpected translation output: {vi}"

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(16000)
        wf.writeframes(struct.pack("<16000h", *([0] * 16000)))
    asr_res = eng.transcribe_and_translate(buf.getvalue())
    print(f"ASR pipeline test: {asr_res}")
    print("CT2 ENGINE SELF-TEST PASSED")


def main() -> int:
    parser = argparse.ArgumentParser(description="InterviewBridge AI CTranslate2 GPU Micro-Engine")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8989)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    if args.self_test:
        run_self_test()
        return 0

    get_engine()
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
