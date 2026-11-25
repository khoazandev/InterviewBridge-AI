#!/usr/bin/env python3
"""Document extractor and CV + JD context builder for InterviewBridge AI."""

from __future__ import annotations

import argparse
import json
import platform
import shutil
import sys
import tempfile
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

SUPPORTED_DOC_EXTS = (".pdf", ".docx", ".txt", ".md", ".json")
TEXT_EXTS = {".txt", ".md", ".json"}
W_NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"

DEFAULT_CONFIG = {
    "configVersion": 1,
    "onboarded": True,
    "layout": "normal",
    "geminiLiveModel": "gemini-3.1-flash-live-preview",
    "groqModel": "qwen/qwen3.6-27b",
    "groqImageModel": "qwen/qwen3.6-27b",
    "disableGroqThinking": True,
}

DEFAULT_CREDENTIALS = {
    "apiKey": "",
    "groqApiKey": "",
}

DEFAULT_PREFERENCES = {
    "customPrompt": "",
    "cvText": "",
    "jdText": "",
    "hrRole": "",
    "hrSalary": "",
    "hrNotice": "",
    "hrReason": "",
    "extraNotes": "",
    "providerMode": "byok",
    "selectedProfile": "hr_bilingual",
    "selectedLanguage": "en-US",
    "selectedScreenshotInterval": "5",
    "selectedImageQuality": "medium",
    "advancedMode": False,
    "audioMode": "speaker_only",
    "fontSize": "medium",
    "backgroundTransparency": 0.8,
    "googleSearchEnabled": False,
    "localLlmModel": "unsloth/Qwen3.5-4B-GGUF:Q4_K_M",
    "whisperModel": "tiny.en",
}


def get_default_config_dir() -> Path:
    """Return the platform-specific config directory matching app/src/storage.js."""
    system = platform.system().lower()
    if system == "windows":
        return Path.home() / "AppData" / "Roaming" / "interview-bridge-config"
    if system == "darwin":
        return Path.home() / "Library" / "Application Support" / "interview-bridge-config"
    return Path.home() / ".config" / "interview-bridge-config"


def _extract_docx_xml(path: Path) -> str:
    """Fallback DOCX extractor using Python's built-in zipfile + ElementTree."""
    with zipfile.ZipFile(path, "r") as zf:
        xml_bytes = zf.read("word/document.xml")
    root = ET.fromstring(xml_bytes)
    paragraphs: list[str] = []
    for p in root.iter(f"{W_NS}p"):
        runs = [t.text for t in p.iter(f"{W_NS}t") if t.text]
        line = "".join(runs).strip()
        if line:
            paragraphs.append(line)
    return "\n".join(paragraphs)


def _extract_docx(path: Path) -> str:
    try:
        import docx  # type: ignore

        document = docx.Document(str(path))
        lines = [p.text.strip() for p in document.paragraphs if p.text and p.text.strip()]
        for table in document.tables:
            for row in table.rows:
                row_text = " | ".join(cell.text.strip() for cell in row.cells if cell.text.strip())
                if row_text:
                    lines.append(row_text)
        if lines:
            return "\n".join(lines)
    except Exception:
        pass
    return _extract_docx_xml(path)


def _extract_pdf(path: Path) -> str:
    try:
        try:
            import pymupdf  # type: ignore
        except ImportError:
            import fitz as pymupdf  # type: ignore

        doc = pymupdf.open(str(path))
        try:
            pages = [page.get_text("text").strip() for page in doc]
        finally:
            doc.close()
        return "\n\n".join(p for p in pages if p)
    except ImportError:
        pass

    try:
        from pypdf import PdfReader  # type: ignore

        reader = PdfReader(str(path))
        pages = [(page.extract_text() or "").strip() for page in reader.pages]
        return "\n\n".join(p for p in pages if p)
    except ImportError as exc:
        raise RuntimeError("Install pypdf to extract PDF files: pip install pypdf") from exc


def extract_text(path: Path) -> str:
    """Extract clean UTF-8 text from .pdf, .docx, .txt, .md, or .json files."""
    if not path.exists():
        raise FileNotFoundError(f"File not found: {path}")

    ext = path.suffix.lower()
    if ext in TEXT_EXTS:
        return path.read_text(encoding="utf-8", errors="replace").strip()
    if ext == ".docx":
        return _extract_docx(path).strip()
    if ext == ".pdf":
        return _extract_pdf(path).strip()
    raise ValueError(f"Unsupported file format '{ext}'. Supported: {', '.join(SUPPORTED_DOC_EXTS)}")


def compose_candidate_context(prefs: dict) -> str:
    """Compile structured HR facts, CV, JD, and extra notes into one prompt block."""
    hr_facts: list[str] = []
    role = str(prefs.get("hrRole") or "").strip()
    salary = str(prefs.get("hrSalary") or "").strip()
    notice = str(prefs.get("hrNotice") or "").strip()
    reason = str(prefs.get("hrReason") or "").strip()

    if role:
        hr_facts.append(f"- Role & Company: {role}")
    if salary:
        hr_facts.append(f"- Expected Salary: {salary}")
    if notice:
        hr_facts.append(f"- Notice Period / Availability: {notice}")
    if reason:
        hr_facts.append(f"- Reason for Job Change: {reason}")

    sections: list[str] = []
    if hr_facts:
        sections.append("=== TARGET ROLE & HR QUICK FACTS ===\n" + "\n".join(hr_facts))

    cv_text = str(prefs.get("cvText") or "").strip()
    if cv_text:
        sections.append("=== CANDIDATE CV / RESUME ===\n" + cv_text)

    jd_text = str(prefs.get("jdText") or "").strip()
    if jd_text:
        sections.append("=== TARGET JOB DESCRIPTION (JD) ===\n" + jd_text)

    extra = str(prefs.get("extraNotes") or "").strip()
    if extra:
        sections.append("=== ADDITIONAL CANDIDATE NOTES ===\n" + extra)

    if not sections:
        return str(prefs.get("customPrompt") or "").strip()

    return "\n\n".join(sections)


def _read_json(path: Path, default: dict) -> dict:
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
        except Exception:
            pass
    return dict(default)


def _write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def sync_to_app_config(
    updates: dict[str, str],
    config_dir: Path | None = None,
    preview_path: Path | None = None,
) -> dict:
    """Persist structured CV/JD/HR fields and compiled customPrompt into Electron config."""
    target_dir = config_dir or get_default_config_dir()
    target_dir.mkdir(parents=True, exist_ok=True)
    (target_dir / "history").mkdir(parents=True, exist_ok=True)

    config_path = target_dir / "config.json"
    existing_config = _read_json(config_path, {})
    if existing_config.get("configVersion") != DEFAULT_CONFIG["configVersion"]:
        merged_config = {**DEFAULT_CONFIG, **existing_config, "configVersion": DEFAULT_CONFIG["configVersion"]}
        _write_json(config_path, merged_config)

    creds_path = target_dir / "credentials.json"
    if not creds_path.exists():
        _write_json(creds_path, DEFAULT_CREDENTIALS)

    prefs_path = target_dir / "preferences.json"
    prefs = {**DEFAULT_PREFERENCES, **_read_json(prefs_path, {})}
    for key, value in updates.items():
        if value is not None:
            prefs[key] = value

    prefs["customPrompt"] = compose_candidate_context(prefs)
    _write_json(prefs_path, prefs)

    if preview_path is not None and prefs["customPrompt"]:
        preview_path.parent.mkdir(parents=True, exist_ok=True)
        preview_path.write_text(prefs["customPrompt"], encoding="utf-8")

    return prefs


def _find_user_doc(user_data_dir: Path, prefix: str) -> Path | None:
    for ext in (".pdf", ".docx", ".md", ".txt"):
        candidate = user_data_dir / f"{prefix}{ext}"
        if candidate.exists() and ".example." not in candidate.name.lower():
            return candidate
    return None


def _load_profile_json(profile_path: Path) -> dict[str, str]:
    raw = json.loads(profile_path.read_text(encoding="utf-8"))
    key_map = {
        "role": "hrRole",
        "hrRole": "hrRole",
        "salary": "hrSalary",
        "hrSalary": "hrSalary",
        "notice": "hrNotice",
        "hrNotice": "hrNotice",
        "reason": "hrReason",
        "hrReason": "hrReason",
        "notes": "extraNotes",
        "extraNotes": "extraNotes",
        "mode": "selectedProfile",
        "selectedProfile": "selectedProfile",
    }
    parsed: dict[str, str] = {}
    for src_key, dest_key in key_map.items():
        if src_key in raw and raw[src_key] is not None:
            parsed[dest_key] = str(raw[src_key]).strip()
    return parsed


def run_self_test() -> None:
    """Verify text extraction, DOCX XML fallback, context compilation, and config sync."""
    tmp = Path(tempfile.mkdtemp(prefix="ib_self_test_"))
    try:
        txt_file = tmp / "jd.txt"
        txt_file.write_text("Backend Engineer — Python & Node.js\nRequirements: FastAPI, SQL.", encoding="utf-8")
        assert "Backend Engineer" in extract_text(txt_file)

        docx_file = tmp / "cv.docx"
        doc_xml = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            "<w:body>"
            "<w:p><w:r><w:t>Nguyen Van A - Software Engineer</w:t></w:r></w:p>"
            "<w:p><w:r><w:t>Kinh nghiệm 2 năm Python và React.</w:t></w:r></w:p>"
            "</w:body>"
            "</w:document>"
        )
        with zipfile.ZipFile(docx_file, "w") as zf:
            zf.writestr("word/document.xml", doc_xml.encode("utf-8"))
        docx_text = extract_text(docx_file)
        assert "Nguyen Van A - Software Engineer" in docx_text
        assert "Kinh nghiệm 2 năm Python và React." in docx_text

        cfg_dir = tmp / "app_cfg"
        preview = tmp / "compiled_context.txt"
        synced = sync_to_app_config(
            {
                "cvText": docx_text,
                "jdText": extract_text(txt_file),
                "hrRole": "Backend Engineer @ Acme",
                "hrSalary": "$1500 gross",
                "hrNotice": "30 days",
                "hrReason": "Looking for product engineering growth",
                "selectedProfile": "hr_bilingual",
            },
            config_dir=cfg_dir,
            preview_path=preview,
        )

        saved_cfg = json.loads((cfg_dir / "config.json").read_text(encoding="utf-8"))
        saved_prefs = json.loads((cfg_dir / "preferences.json").read_text(encoding="utf-8"))
        assert saved_cfg.get("configVersion") == 1
        assert saved_cfg.get("onboarded") is True
        assert "=== TARGET ROLE & HR QUICK FACTS ===" in saved_prefs["customPrompt"]
        assert "=== CANDIDATE CV / RESUME ===" in saved_prefs["customPrompt"]
        assert "=== TARGET JOB DESCRIPTION (JD) ===" in saved_prefs["customPrompt"]
        assert "Nguyen Van A" in saved_prefs["customPrompt"]
        assert "Backend Engineer @ Acme" in saved_prefs["customPrompt"]
        assert synced["customPrompt"] == saved_prefs["customPrompt"]
        assert preview.exists()

        print("SELF-TEST PASSED")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="InterviewBridge AI CV + JD Context Builder")
    parser.add_argument("--extract", type=Path, help="Extract plain text from a single file and print to stdout")
    parser.add_argument("--auto-sync", action="store_true", help="Scan user-data/ for cv.*, jd.*, and profile.json")
    parser.add_argument("--cv", type=Path, help="Path to candidate CV/Resume (.pdf, .docx, .txt, .md)")
    parser.add_argument("--jd", type=Path, help="Path to target Job Description (.pdf, .docx, .txt, .md)")
    parser.add_argument("--profile-json", type=Path, help="Path to profile JSON containing HR quick facts")
    parser.add_argument("--role", help="Target role and company")
    parser.add_argument("--salary", help="Expected salary")
    parser.add_argument("--notice", help="Notice period / earliest start date")
    parser.add_argument("--reason", help="Reason for job change / joining")
    parser.add_argument("--notes", help="Additional notes or instructions")
    parser.add_argument("--mode", help="Profile mode (hr_bilingual, tech_bilingual, interview)")
    parser.add_argument("--config-dir", type=Path, help="Override target Electron config directory")
    parser.add_argument("--self-test", action="store_true", help="Run built-in unit self-test and exit")
    args = parser.parse_args()

    if args.self_test:
        run_self_test()
        return 0

    if args.extract is not None:
        print(extract_text(args.extract))
        return 0

    repo_root = Path(__file__).resolve().parent.parent
    user_data_dir = repo_root / "user-data"
    preview_path = user_data_dir / "compiled_context.txt" if args.config_dir is None else None
    updates: dict[str, str] = {}

    if args.auto_sync:
        cv_doc = _find_user_doc(user_data_dir, "cv")
        jd_doc = _find_user_doc(user_data_dir, "jd")
        profile_json = user_data_dir / "profile.json"
        has_profile = profile_json.exists()

        if not cv_doc and not jd_doc and not has_profile:
            print("[context_builder] No custom cv.*, jd.*, or profile.json in user-data/. Keeping existing app context.")
            return 0

        if has_profile:
            updates.update(_load_profile_json(profile_json))
        if cv_doc:
            updates["cvText"] = extract_text(cv_doc)
        if jd_doc:
            updates["jdText"] = extract_text(jd_doc)
    else:
        if args.profile_json:
            updates.update(_load_profile_json(args.profile_json))
        if args.cv:
            updates["cvText"] = extract_text(args.cv)
        if args.jd:
            updates["jdText"] = extract_text(args.jd)
        if args.role is not None:
            updates["hrRole"] = args.role.strip()
        if args.salary is not None:
            updates["hrSalary"] = args.salary.strip()
        if args.notice is not None:
            updates["hrNotice"] = args.notice.strip()
        if args.reason is not None:
            updates["hrReason"] = args.reason.strip()
        if args.notes is not None:
            updates["extraNotes"] = args.notes.strip()
        if args.mode is not None:
            updates["selectedProfile"] = args.mode.strip()

    if not updates:
        parser.print_help()
        return 1

    prefs = sync_to_app_config(updates, config_dir=args.config_dir, preview_path=preview_path)
    target_dir = args.config_dir or get_default_config_dir()
    playbook_src = user_data_dir / "playbook.json"
    if playbook_src.exists():
        shutil.copy2(playbook_src, target_dir / "playbook.json")
    print(
        f"[context_builder] Synced to {target_dir / 'preferences.json'} "
        f"(profile={prefs.get('selectedProfile')}, cv={len(prefs.get('cvText', ''))} chars, "
        f"jd={len(prefs.get('jdText', ''))} chars)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
