import { html, css, LitElement } from '../../assets/lit-core-2.7.4.min.js';
import { unifiedPageStyles } from './sharedPageStyles.js';

export class AICustomizeView extends LitElement {
    static styles = [
        unifiedPageStyles,
        css`
            .studio-header {
                display: flex;
                align-items: flex-start;
                justify-content: space-between;
                gap: var(--space-md);
                flex-wrap: wrap;
            }
            .status-badge {
                font-size: var(--font-size-xs);
                color: var(--success);
                background: rgba(34, 197, 94, 0.08);
                border: 1px solid rgba(34, 197, 94, 0.25);
                padding: 4px 10px;
                border-radius: 999px;
                white-space: nowrap;
            }
            .status-badge.error {
                color: var(--danger);
                background: rgba(239, 68, 68, 0.08);
                border-color: rgba(239, 68, 68, 0.25);
            }
            .facts-grid {
                display: grid;
                grid-template-columns: repeat(2, minmax(0, 1fr));
                gap: var(--space-sm);
                margin-top: var(--space-sm);
            }
            @media (max-width: 640px) {
                .facts-grid {
                    grid-template-columns: 1fr;
                }
            }
            .field-block {
                display: flex;
                flex-direction: column;
                gap: 4px;
            }
            .field-block .control {
                width: 100%;
                user-select: text;
                cursor: text;
            }
            .section-bar {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: var(--space-sm);
                flex-wrap: wrap;
                margin-bottom: var(--space-xs);
            }
            .section-actions {
                display: flex;
                align-items: center;
                gap: var(--space-xs);
            }
            .btn-mini {
                border: 1px solid var(--border-strong);
                background: var(--bg-elevated);
                color: var(--text-primary);
                border-radius: var(--radius-sm);
                padding: 4px 10px;
                font-size: var(--font-size-xs);
                font-weight: var(--font-weight-medium);
                cursor: pointer;
                transition: background var(--transition), border-color var(--transition);
            }
            .btn-mini:hover {
                background: var(--bg-hover);
                border-color: var(--text-muted);
            }
            .btn-mini.danger {
                color: var(--danger);
            }
            textarea.doc-area {
                width: 100%;
                min-height: 130px;
                resize: vertical;
                user-select: text;
                cursor: text;
                font-size: var(--font-size-sm);
                line-height: 1.5;
            }
            textarea.notes-area {
                width: 100%;
                min-height: 64px;
                resize: vertical;
                user-select: text;
                cursor: text;
                font-size: var(--font-size-sm);
                line-height: 1.45;
            }
        `,
    ];

    static properties = {
        selectedProfile: { type: String },
        onProfileChange: { type: Function },
        _cvText: { state: true },
        _jdText: { state: true },
        _hrRole: { state: true },
        _hrSalary: { state: true },
        _hrNotice: { state: true },
        _hrReason: { state: true },
        _extraNotes: { state: true },
        _statusMsg: { state: true },
        _statusIsError: { state: true },
    };

    constructor() {
        super();
        this.selectedProfile = 'hr_bilingual';
        this.onProfileChange = () => {};
        this._cvText = '';
        this._jdText = '';
        this._hrRole = '';
        this._hrSalary = '';
        this._hrNotice = '';
        this._hrReason = '';
        this._extraNotes = '';
        this._statusMsg = '';
        this._statusIsError = false;
        this._loadFromStorage();
    }

    connectedCallback() {
        super.connectedCallback();
        this._loadFromStorage();
    }

    async _loadFromStorage() {
        try {
            const prefs = await cheatingDaddy.storage.getPreferences();
            this._cvText = prefs.cvText || '';
            this._jdText = prefs.jdText || '';
            this._hrRole = prefs.hrRole || '';
            this._hrSalary = prefs.hrSalary || '';
            this._hrNotice = prefs.hrNotice || '';
            this._hrReason = prefs.hrReason || '';
            this._extraNotes = prefs.extraNotes || '';
            if (!this._cvText && !this._jdText && prefs.customPrompt) {
                this._extraNotes = prefs.customPrompt;
            }
            this.requestUpdate();
        } catch (error) {
            console.error('Error loading CV + JD Studio storage:', error);
        }
    }

    _handleProfileChange(e) {
        this.onProfileChange(e.target.value);
    }

    async _updateField(stateKey, prefKey, val) {
        this[stateKey] = val;
        this._statusMsg = 'Auto-saved for Live Session';
        this._statusIsError = false;
        await cheatingDaddy.storage.updatePreference(prefKey, val);
    }

    async _importDocument(stateKey, prefKey, label) {
        if (!window.require) return;
        try {
            const { ipcRenderer } = window.require('electron');
            const res = await ipcRenderer.invoke('dialog:import-document');
            if (res?.canceled) return;
            if (!res?.success) {
                this._statusMsg = `Import ${label} failed: ${res?.error || 'Unknown error'}`;
                this._statusIsError = true;
                return;
            }
            await this._updateField(stateKey, prefKey, res.text || '');
            this._statusMsg = `Imported ${res.fileName} (${(res.text || '').length} chars)`;
            this._statusIsError = false;
        } catch (error) {
            this._statusMsg = `Import ${label} failed: ${error.message}`;
            this._statusIsError = true;
        }
    }

    render() {
        const profiles = [
            { value: 'hr_bilingual', label: 'HR Screening (EN → VI + Simple B1-B2)' },
            { value: 'tech_bilingual', label: 'Technical Interview (EN → VI + Tech/STAR)' },
            { value: 'interview', label: 'Job Interview (English Only)' },
            { value: 'sales', label: 'Sales Call' },
            { value: 'meeting', label: 'Business Meeting' },
            { value: 'presentation', label: 'Presentation' },
            { value: 'negotiation', label: 'Negotiation' },
            { value: 'exam', label: 'Exam Assistant' },
        ];

        const badgeText =
            this._statusMsg ||
            `✓ Auto-saved for Live Session · CV: ${this._cvText.trim().length} chars · JD: ${this._jdText.trim().length} chars`;

        return html`
            <div class="unified-page">
                <div class="unified-wrap">
                    <div class="studio-header">
                        <div>
                            <div class="page-title">CV + JD Studio</div>
                            <div class="page-subtitle">Import your CV & target JD to ground real-time bilingual interview answers.</div>
                        </div>
                        <div class="status-badge ${this._statusIsError ? 'error' : ''}">${badgeText}</div>
                    </div>

                    <section class="surface">
                        <div class="form-group">
                            <div>
                                <div class="surface-title">Interview Mode</div>
                                <div class="form-help">Bilingual modes show a 1-line Vietnamese summary + simple spoken English bullets.</div>
                            </div>
                            <select class="control" style="width: 310px;" .value=${this.selectedProfile} @change=${this._handleProfileChange}>
                                ${profiles.map(profile => html`<option value=${profile.value}>${profile.label}</option>`)}
                            </select>
                        </div>

                        <div class="facts-grid">
                            <div class="field-block">
                                <label class="form-label">Role & Company</label>
                                <input
                                    type="text"
                                    class="control"
                                    placeholder="e.g., Junior Backend Engineer @ Acme"
                                    .value=${this._hrRole}
                                    @input=${e => this._updateField('_hrRole', 'hrRole', e.target.value)}
                                />
                            </div>
                            <div class="field-block">
                                <label class="form-label">Expected Salary</label>
                                <input
                                    type="text"
                                    class="control"
                                    placeholder="e.g., $1,200-$1,500 gross / negotiable"
                                    .value=${this._hrSalary}
                                    @input=${e => this._updateField('_hrSalary', 'hrSalary', e.target.value)}
                                />
                            </div>
                            <div class="field-block">
                                <label class="form-label">Notice Period / Start Date</label>
                                <input
                                    type="text"
                                    class="control"
                                    placeholder="e.g., Immediate / 30 days after offer"
                                    .value=${this._hrNotice}
                                    @input=${e => this._updateField('_hrNotice', 'hrNotice', e.target.value)}
                                />
                            </div>
                            <div class="field-block">
                                <label class="form-label">Reason for Leaving / Joining</label>
                                <input
                                    type="text"
                                    class="control"
                                    placeholder="e.g., Seeking global product & English growth"
                                    .value=${this._hrReason}
                                    @input=${e => this._updateField('_hrReason', 'hrReason', e.target.value)}
                                />
                            </div>
                        </div>
                    </section>

                    <section class="surface">
                        <div class="section-bar">
                            <div class="section-actions">
                                <span class="surface-title" style="margin: 0;">Candidate CV / Resume</span>
                                <span class="chip">${this._cvText.trim().length} chars</span>
                            </div>
                            <div class="section-actions">
                                <button class="btn-mini" @click=${() => this._importDocument('_cvText', 'cvText', 'CV')}>
                                    Import File (.pdf/.docx/.txt/.md)
                                </button>
                                <button class="btn-mini danger" @click=${() => this._updateField('_cvText', 'cvText', '')}>Clear</button>
                            </div>
                        </div>
                        <textarea
                            class="control doc-area"
                            placeholder="Paste your CV/Resume text here or click Import File..."
                            .value=${this._cvText}
                            @input=${e => this._updateField('_cvText', 'cvText', e.target.value)}
                        ></textarea>
                    </section>

                    <section class="surface">
                        <div class="section-bar">
                            <div class="section-actions">
                                <span class="surface-title" style="margin: 0;">Target Job Description (JD)</span>
                                <span class="chip">${this._jdText.trim().length} chars</span>
                            </div>
                            <div class="section-actions">
                                <button class="btn-mini" @click=${() => this._importDocument('_jdText', 'jdText', 'JD')}>
                                    Import File (.pdf/.docx/.txt/.md)
                                </button>
                                <button class="btn-mini danger" @click=${() => this._updateField('_jdText', 'jdText', '')}>Clear</button>
                            </div>
                        </div>
                        <textarea
                            class="control doc-area"
                            placeholder="Paste the Job Description (requirements, responsibilities) here or click Import File..."
                            .value=${this._jdText}
                            @input=${e => this._updateField('_jdText', 'jdText', e.target.value)}
                        ></textarea>
                    </section>

                    <section class="surface">
                        <div class="section-bar">
                            <span class="surface-title" style="margin: 0;">Additional Instructions / Notes</span>
                            <span class="chip">${this._extraNotes.trim().length} chars</span>
                        </div>
                        <textarea
                            class="control notes-area"
                            placeholder="Extra reminders, preferred tone, key projects to emphasize..."
                            .value=${this._extraNotes}
                            @input=${e => this._updateField('_extraNotes', 'extraNotes', e.target.value)}
                        ></textarea>
                    </section>
                </div>
            </div>
        `;
    }
}

customElements.define('ai-customize-view', AICustomizeView);
