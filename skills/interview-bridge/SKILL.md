---
name: interview-bridge
description: >
  Prepare for and configure real-time bilingual (English -> Vietnamese) HR or technical
  interviews grounded in a candidate's CV and target Job Description (JD). Use this skill
  whenever the user mentions preparing for an English interview, HR screening, mock interview,
  loading a CV + JD into InterviewBridge AI, matching their resume against a JD, generating
  spoken B1-B2 interview bullet points, or practicing answers for a specific role or company.
---

# InterviewBridge AI — CV + JD Interview Prep & Live Copilot Skill

This skill prepares a candidate for live English interviews by grounding both pre-interview coaching and the live desktop copilot (`InterviewBridge-AI`) strictly in the user's real **CV/Resume** and target **Job Description (JD)**.

## Workflow

### Step 1: Gather Candidate Inputs
Ask for (or locate in `user-data/` or the user's message) the following inputs before generating materials:
1. **Candidate CV / Resume** (`.pdf`, `.docx`, `.txt`, `.md`, or pasted text)
2. **Target Job Description (JD)** (`.pdf`, `.docx`, `.txt`, `.md`, or pasted text)
3. **HR Quick Facts** (especially important for HR screening rounds):
   - Target Role & Company
   - Expected Salary (or range / negotiable stance)
   - Notice Period / Earliest Start Date
   - Reason for leaving current job / joining target company
4. **Round Type**:
   - `hr_bilingual` (default — HR screening, culture fit, salary/availability, behavioral)
   - `tech_bilingual` (technical deep-dive, system design, live coding)

### Step 2: Sync CV + JD Directly into the Live Desktop App
If this repository is checked out locally, run `scripts/context_builder.py` so the Electron overlay app (`InterviewBridge AI`) loads the compiled context automatically on next launch:

```bash
python scripts/context_builder.py \
  --cv "<path-to-cv>" \
  --jd "<path-to-jd>" \
  --role "<Role @ Company>" \
  --salary "<Expected salary>" \
  --notice "<Notice period>" \
  --reason "<Reason for change>" \
  --mode hr_bilingual
```

*(If the user only pasted text rather than files, save temporary or `user-data/cv.md` and `user-data/jd.md` files first and pass them to `--cv` and `--jd`. Note that `user-data/*` excluding `*.example.*` is git-ignored for privacy.)*

### Step 3: Run CV ↔ JD Fit & Gap Analysis
Compare the CV against the JD honestly and concisely:
- **Strong Matches (3–5 points):** Skills, projects, and outcomes in the CV that directly satisfy the JD's core requirements.
- **Potential Gaps & Honest Pivots (2–3 points):** Required/nice-to-have JD skills missing from the CV, paired with an honest, confident bridge phrase (e.g., *"I haven't used X in production yet, but I built similar Y using Z and can pick X up quickly."*). Never fabricate skills, employers, or metrics.

### Step 4: Generate `user-data/interview_cheatsheet.md`
Produce a scannable, speak-out-loud cheatsheet tailored to the candidate's actual English comfort level (clear B1–B2 spoken English, 8–14 words per bullet, avoiding stiff C2 vocabulary):
1. **60-Second Self-Introduction (`Tell me about yourself`)**: 4–5 natural spoken sentences connecting current experience -> strongest relevant project -> why this role/company.
2. **Top 8 Tailored Questions & Bilingual Talking Points**:
   - Cover role fit, strongest project, teamwork/conflict, weakness/gap, why this company, salary expectation, notice period, and one domain-specific JD question.
   - Format every answer identically to the live overlay:
     - **🇻🇳 Ý câu hỏi:** 1-line Vietnamese meaning
     - **🗣️ Gợi ý nói:** 3 short, natural first-person English bullets (`- I ...`) grounded in the CV & JD
3. **3 Smart Questions to Ask the Interviewer** at the end of the call.

## Live Session Usage Tips
- Remind the user to run `start.bat` (launches `LiveCaptionsTranslator.exe` for 0ms English-to-Vietnamese captions + the `InterviewBridge AI` Electron overlay).
- Position the overlay window right below the webcam (`Ctrl + Arrow Keys`) and toggle click-through (`Ctrl + M`) during the call.
- Test audio capture before the real call by playing a YouTube *"HR English Mock Interview"* video (Windows captures speaker/headphone loopback audio, not the user's mic).
