/**
 * Survey Record Management System
 * Main Application Logic
 */

const app = {
    // State
    currentUser: null,
   apiBaseUrl: 'http://localhost:3000',
    surveys: [],
    systemUsers: [],
    auditLogs: [],
    currentFile: null,          // legacy single-file support
    currentSurvey: null,
    editingSurveyId: null,
    map: null,
    allWorkMap: null,
    allWorkLayer: null,
    marker: null,

    // Users
    users: [
        { username: 'His Mercy', password: 'mercy123', name: 'HISMERCY', role: 'Admin' },
        { username: 'surveyor1', password: 'pass123', name: 'John Smith', role: 'Surveyor' },
        { username: 'surveyor2', password: 'pass123', name: 'Jane Doe', role: 'Surveyor' }
    ],

    // Job type labels
    jobTypeLabels: {
        'change-title': 'Change Title',
        'additional-portion': 'Additional Portion',
        'plan-updating': 'Plan Updating',
        'pillars-picked': 'Pillars Picked on Ground',
        'plan-compilation': 'Plan Compilation',
        'fresh-pillar': 'Fresh Pillar',
        'subdivision': 'Subdivision'
    },

    /**
     * Initialize the application
     */
    async init() {
        await this.loadData();
        await this.loadUsers();
        await this.loadAuditLogs();
        this.setupEventListeners();
        this.checkAuth();
        this.setDefaultSurveyDate();
        this.updateFileStatusBadge();
    },

    /**
     * Small DOM helper
     */
    getEl(id) {
        return document.getElementById(id);
    },

    /**
     * Load local records and backend records, then sync the merged copy.
     */
    async loadData() {
        const localSurveys = this.getStoredSurveys();
        this.surveys = localSurveys;

        try {
            const response = await fetch(`${this.apiBaseUrl}/api/surveys`);
            if (!response.ok) throw new Error('Backend request failed');

            const data = await response.json();
            const backendSurveys = Array.isArray(data.surveys) ? data.surveys : [];
            this.surveys = this.mergeSurveyLists(backendSurveys, localSurveys);
            localStorage.setItem('surveys', JSON.stringify(this.surveys));

            await this.saveData({ clearDeletedIds: true });
        } catch (error) {
            console.warn('Using localStorage because backend is unavailable:', error.message);
            this.surveys = localSurveys;
        }
    },

    isAdmin() {
        return this.currentUser?.role === 'admin' || this.currentUser?.role === 'Admin';
    },

    /**
     * Read saved records from localStorage.
     */
    getStoredSurveys() {
        try {
            const stored = localStorage.getItem('surveys');
            return stored ? JSON.parse(stored) : [];
        } catch (error) {
            console.warn('Could not read local survey records:', error.message);
            return [];
        }
    },

    /**
     * Track records deleted while the backend is unavailable.
     */
    getDeletedSurveyIds() {
        try {
            const stored = localStorage.getItem('deletedSurveyIds');
            return stored ? JSON.parse(stored).map(String) : [];
        } catch (error) {
            return [];
        }
    },

    rememberDeletedSurveyId(id) {
        const deletedIds = new Set(this.getDeletedSurveyIds());
        deletedIds.add(String(id));
        localStorage.setItem('deletedSurveyIds', JSON.stringify([...deletedIds]));
    },

    /**
     * Merge backend and local records. Newer local offline records win.
     */
    mergeSurveyLists(backendSurveys, localSurveys) {
        const deletedIds = new Set(this.getDeletedSurveyIds());
        const byId = new Map();

        [...backendSurveys, ...localSurveys].forEach(survey => {
            if (!survey || deletedIds.has(String(survey.id))) return;

            const key = String(survey.id);
            const existing = byId.get(key);

            if (!existing || this.getSurveyTimestamp(survey) >= this.getSurveyTimestamp(existing)) {
                byId.set(key, survey);
            }
        });

        return [...byId.values()].sort((a, b) => this.getSurveyTimestamp(b) - this.getSurveyTimestamp(a));
    },

    getSurveyTimestamp(survey) {
        const value = survey?.updatedAt || survey?.createdAt || 0;
        const timestamp = new Date(value).getTime();
        return Number.isNaN(timestamp) ? 0 : timestamp;
    },

    /**
     * Save data to localStorage and sync to MySQL through the backend.
     */
    async saveData(options = {}) {
        localStorage.setItem('surveys', JSON.stringify(this.surveys));

        const response = await fetch(`${this.apiBaseUrl}/api/surveys/bulk`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ surveys: this.surveys })
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.message || 'Failed to sync records to backend');
        }

        if (options.clearDeletedIds !== false) {
            localStorage.removeItem('deletedSurveyIds');
        }
    },

    async loadUsers() {
        try {
            const response = await fetch(`${this.apiBaseUrl}/api/users`);
            if (!response.ok) throw new Error('Could not load users');

            const data = await response.json();
            this.systemUsers = Array.isArray(data.users) ? data.users : [];
        } catch (error) {
            console.warn('Could not load backend users:', error.message);
            this.systemUsers = [];
        }
    },

    async loadAuditLogs() {
        try {
            const response = await fetch(`${this.apiBaseUrl}/api/audit-logs`);
            if (!response.ok) throw new Error('Could not load audit logs');

            const data = await response.json();
            this.auditLogs = Array.isArray(data.logs) ? data.logs : [];
        } catch (error) {
            console.warn('Could not load audit logs:', error.message);
            this.auditLogs = [];
        }
    },

    async logAudit(action, entityType, entityId, details = {}) {
        try {
            await fetch(`${this.apiBaseUrl}/api/audit-logs`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action,
                    entityType,
                    entityId,
                    actorId: this.currentUser?.id || null,
                    actorName: this.currentUser?.name || 'Unknown',
                    actorRole: this.currentUser?.role || 'Unknown',
                    details
                })
            });
        } catch (error) {
            console.warn('Audit log failed:', error.message);
        }
    },

    getRecordOwnerKey(survey) {
        return String(survey?.createdByUserId || survey?.createdBy || survey?.surveyor || 'Unknown').toLowerCase();
    },

    getRecordOwnerName(survey) {
        return survey?.createdBy || survey?.surveyor || 'Unknown';
    },

    /**
     * Check authentication status
     */
    checkAuth() {
        const session = sessionStorage.getItem('currentUser');
        if (session) {
            this.currentUser = JSON.parse(session);
            this.showDashboard();
        }
    },

    /**
     * Setup all event listeners
     */
    setupEventListeners() {
        // Login form
        const loginForm = this.getEl('loginForm');
        if (loginForm) {
            loginForm.addEventListener('submit', (e) => {
                e.preventDefault();
                this.handleLogin();
            });
        }

        const registerForm = this.getEl('registerForm');
        if (registerForm) {
            registerForm.addEventListener('submit', (e) => {
                e.preventDefault();
                this.handleRegister();
            });
        }

        // Survey form
        const surveyForm = this.getEl('surveyForm');
        if (surveyForm) {
            surveyForm.addEventListener('submit', (e) => {
                e.preventDefault();
                this.handleSaveSurvey();
            });
        }

        // Navigation
        document.querySelectorAll('.nav-item').forEach(item => {
            item.addEventListener('click', () => {
                const tab = item.dataset.tab;
                if (tab) this.showTab(tab);
            });
        });

        // Modal close on outside click
        const surveyModal = this.getEl('surveyModal');
        if (surveyModal) {
            surveyModal.addEventListener('click', (e) => {
                if (e.target.id === 'surveyModal') {
                    this.closeModal();
                }
            });
        }

        // File inputs for the new multi-document system
        const fileSurveyPlan = this.getEl('fileSurveyPlan');
        const fileRecordCopy = this.getEl('fileRecordCopy');
        const fileCOO = this.getEl('fileCOO');
        const fileOther = this.getEl('fileOther');
        const otherDocName = this.getEl('otherDocName');

        [fileSurveyPlan, fileRecordCopy, fileCOO, fileOther].forEach(input => {
            if (input) {
                input.addEventListener('change', () => this.updateFileStatusBadge());
            }
        });

        if (otherDocName) {
            otherDocName.addEventListener('input', () => this.updateFileStatusBadge());
        }

        // Legacy dropzone support (in case you still have the old HTML somewhere)
        const dropZone = this.getEl('dropZone');
        const fileInput = this.getEl('fileInput');

        if (dropZone) {
            dropZone.addEventListener('click', () => {
                if (fileInput) fileInput.click();
            });

            dropZone.addEventListener('dragover', (e) => {
                e.preventDefault();
                dropZone.classList.add('dragover');
            });

            dropZone.addEventListener('dragleave', () => {
                dropZone.classList.remove('dragover');
            });

            dropZone.addEventListener('drop', (e) => {
                e.preventDefault();
                dropZone.classList.remove('dragover');
                if (e.dataTransfer.files.length) {
                    this.handleFile(e.dataTransfer.files[0]);
                }
            });
        }

        if (fileInput) {
            fileInput.addEventListener('change', (e) => {
                if (e.target.files[0]) {
                    this.handleFile(e.target.files[0]);
                }
            });
        }
    },

    /**
     * Set today's date in the date field
     */
    setDefaultSurveyDate() {
        const dateInput = this.getEl('surveyDate');
        if (dateInput && !dateInput.value) {
            const today = new Date();
            const yyyy = today.getFullYear();
            const mm = String(today.getMonth() + 1).padStart(2, '0');
            const dd = String(today.getDate()).padStart(2, '0');
            dateInput.value = `${yyyy}-${mm}-${dd}`;
        }
    },

    /**
     * Handle user login
     */
    toggleRegister(showRegister) {
        const loginForm = this.getEl('loginForm');
        const registerForm = this.getEl('registerForm');

        if (loginForm) loginForm.classList.toggle('hidden', showRegister);
        if (registerForm) registerForm.classList.toggle('hidden', !showRegister);
    },

    async handleRegister() {
        const fullName = this.getEl('registerFullName')?.value.trim();
        const username = this.getEl('registerUsername')?.value.trim();
        const email = this.getEl('registerEmail')?.value.trim();
        const password = this.getEl('registerPassword')?.value;

        try {
            const response = await fetch(`${this.apiBaseUrl}/api/auth/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fullName, username, email, password })
            });
            const data = await response.json().catch(() => ({}));

            if (!response.ok) {
                throw new Error(data.message || 'Registration failed');
            }

            this.getEl('registerForm')?.reset();
            this.toggleRegister(false);
            this.showToast(data.message || 'Registration submitted for approval.', 'success');
            await this.loadUsers();
        } catch (error) {
            this.showToast(error.message, 'error');
        }
    },

    async handleLogin() {
        const usernameInput = this.getEl('username');
        const passwordInput = this.getEl('password');

        if (!usernameInput || !passwordInput) {
            this.showToast('Form elements not found!', 'error');
            return;
        }

        const username = usernameInput.value.trim();
        const password = passwordInput.value;

        try {
            const response = await fetch(`${this.apiBaseUrl}/api/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            const data = await response.json().catch(() => ({}));

            if (!response.ok) {
                throw new Error(data.message || 'Invalid credentials. Please try again.');
            }

            const user = data.user;
            this.currentUser = {
                id: user.id,
                username: user.username,
                name: user.name,
                role: user.role,
                status: user.status
            };
            sessionStorage.setItem('currentUser', JSON.stringify(user));
            await this.loadUsers();
            this.showDashboard();
            this.showToast('Welcome back, ' + user.name + '!', 'success');
        } catch (error) {
            this.showToast(error.message, 'error');
        }
    },

    /**
     * Logout user
     */
    logout() {
        this.currentUser = null;
        sessionStorage.removeItem('currentUser');

        const loginPage = this.getEl('loginPage');
        const dashboard = this.getEl('dashboard');
        const loginForm = this.getEl('loginForm');

        if (loginPage) loginPage.classList.remove('hidden');
        if (dashboard) dashboard.classList.add('hidden');
        if (loginForm) loginForm.reset();
    },

    /**
     * Show dashboard
     */
    showDashboard() {
        const loginPage = this.getEl('loginPage');
        const dashboard = this.getEl('dashboard');

        if (loginPage) loginPage.classList.add('hidden');
        if (dashboard) dashboard.classList.remove('hidden');

        const userNameEl = this.getEl('currentUserName');
        const userRoleEl = this.getEl('currentUserRole');
        const userAvatarEl = this.getEl('userAvatar');

        if (userNameEl) userNameEl.textContent = this.currentUser.name;
        if (userRoleEl) userRoleEl.textContent = this.currentUser.role;
        if (userAvatarEl) userAvatarEl.textContent = this.currentUser.name.charAt(0).toUpperCase();

        const adminNav = this.getEl('adminNav');
        if (adminNav) adminNav.classList.toggle('hidden', !this.isAdmin());

        this.showTab('add');
    },

    /**
     * Switch tabs
     */
    showTab(tabName) {
        document.querySelectorAll('.nav-item').forEach(item => {
            item.classList.toggle('active', item.dataset.tab === tabName);
        });

        document.querySelectorAll('.tab-content').forEach(content => {
            content.classList.remove('active');
        });

        const targetTab = this.getEl(tabName + 'Tab');
        if (targetTab) {
            targetTab.classList.add('active');
        }

        const pageTitle = this.getEl('pageTitle');
        const titles = {
            add: 'Add New Survey',
            view: 'Survey Records',
            analytics: 'Analytics Dashboard',
            allMap: 'All Work Map',
            admin: 'Admin Control'
        };
        if (pageTitle) pageTitle.textContent = titles[tabName] || '';

        if (tabName === 'view') {
            this.renderSurveyList();
        } else if (tabName === 'analytics') {
            this.updateAnalytics();
        } else if (tabName === 'allMap') {
            this.populateAllMapFilters();
            setTimeout(() => this.renderAllWorkMap(), 80);
        } else if (tabName === 'admin') {
            if (!this.isAdmin()) {
                this.showToast('Administrator access only.', 'error');
                this.showTab('add');
                return;
            }
            this.renderAdminPanel();
        }
    },

    /**
     * Legacy file selection support
     */
    handleFile(file) {
        if (!file) return;

        if (file.size > 10 * 1024 * 1024) {
            this.showToast('File size must be less than 10MB', 'error');
            return;
        }

        this.currentFile = file;

        const fileNameEl = this.getEl('fileName');
        const fileSizeEl = this.getEl('fileSize');
        const filePreview = this.getEl('filePreview');
        const dropZone = this.getEl('dropZone');

        if (fileNameEl) fileNameEl.textContent = file.name;
        if (fileSizeEl) fileSizeEl.textContent = this.formatFileSize(file.size);
        if (filePreview) filePreview.classList.remove('hidden');
        if (dropZone) dropZone.classList.add('hidden');

        this.updateFileStatusBadge();
    },

    /**
     * Remove selected legacy file
     */
    removeFile() {
        this.currentFile = null;

        const fileInput = this.getEl('fileInput');
        const filePreview = this.getEl('filePreview');
        const dropZone = this.getEl('dropZone');

        if (fileInput) fileInput.value = '';
        if (filePreview) filePreview.classList.add('hidden');
        if (dropZone) dropZone.classList.remove('hidden');

        this.updateFileStatusBadge();
    },

    /**
     * Format file size
     */
    formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    },

    /**
     * Get job type label
     */
    getJobTypeLabel(value) {
        return this.jobTypeLabels[value] || value || '-';
    },

    /**
     * Get selected multi-files from the form
     */
    getSelectedMultiFiles() {
        const surveyPlan = this.getEl('fileSurveyPlan')?.files?.[0] || null;
        const recordCopy = this.getEl('fileRecordCopy')?.files?.[0] || null;
        const cod = this.getEl('fileCOO')?.files?.[0] || null;
        const other = this.getEl('fileOther')?.files?.[0] || null;
        const otherDocName = this.getEl('otherDocName')?.value?.trim() || '';
        const recordCopySubmitted = this.getEl('recordCopySubmitted')?.checked || false;

       return {
    surveyPlan,
    recordCopy,
    cod,
    other,
    otherDocName,
    recordCopySubmitted
};
    },

    /**
     * Update file status badge on the form
     */
    updateFileStatusBadge() {
        const badge = this.getEl('fileStatusBadge');
        if (!badge) return;

        const files = this.getSelectedMultiFiles();
        const existingSurvey = this.editingSurveyId !== null
            ? this.surveys.find(s => s.id === this.editingSurveyId)
            : null;
        const existingFiles = existingSurvey?.files || {};
        const fileLabels = {
            fileSurveyPlanName: files.surveyPlan?.name || existingFiles.surveyPlan?.name || 'No file chosen',
            fileRecordCopyName: files.recordCopy?.name || existingFiles.recordCopy?.name || 'No file chosen',
            fileCOOName: files.cod?.name || existingFiles.cod?.name || 'No file chosen',
            fileOtherName: files.other?.name || existingFiles.other?.name || 'No documents selected'
        };

        Object.entries(fileLabels).forEach(([id, label]) => {
            const el = this.getEl(id);
            if (el) el.textContent = label;
        });

        const plan = !!(files.surveyPlan || existingFiles.surveyPlan);
        const record = !!(files.recordCopy || existingFiles.recordCopy);
        const cod = !!(files.cod || existingFiles.cod);

        badge.classList.remove('file-status-blue', 'file-status-yellow', 'file-status-green');
        badge.textContent = '';

        if (plan && record && cod) {
            badge.classList.add('file-status-green');
            badge.textContent = 'All three major files attached';
        } else if (plan && record) {
            badge.classList.add('file-status-yellow');
            badge.textContent = 'Survey plan + record copy attached';
        } else if (plan) {
            badge.classList.add('file-status-blue');
            badge.textContent = 'Survey plan attached';
        } else if (record || cod || files.other) {
            badge.classList.add('file-status-blue');
            badge.textContent = 'File attached';
        } else {
            badge.classList.add('badge', 'badge-secondary');
            badge.textContent = 'No documents selected';
        }
    },

    /**
     * Convert file to base64
     */
    fileToDataURL(file) {
        return new Promise((resolve, reject) => {
            if (!file) {
                resolve(null);
                return;
            }

            const reader = new FileReader();
            reader.onload = e => resolve(e.target.result);
            reader.onerror = () => reject(new Error('Failed to read file'));
            reader.readAsDataURL(file);
        });
    },

    /**
     * Save survey record
     */
    async handleSaveSurvey() {
        const surveyorEl = this.getEl('surveyor');
        const surveyNumberEl = this.getEl('surveyNumber');
        const surveyNameEl = this.getEl('surveyName');
        const surveyAreaEl = this.getEl('surveyArea');
        const areaUnitEl = this.getEl('areaUnit');
        const localGovEl = this.getEl('localGov');
        const surveyDateEl = this.getEl('surveyDate');
        const observedByEl = this.getEl('observedBy');
        const jobTypeEl = this.getEl('jobType');
        const eastingEl = this.getEl('easting');
        const northingEl = this.getEl('northing');
        const descriptionEl = this.getEl('description');
        const remarkEl = this.getEl('surveyRemark');

        if (
            !surveyorEl || !surveyNumberEl || !surveyNameEl || !surveyAreaEl ||
            !areaUnitEl || !localGovEl || !surveyDateEl || !observedByEl ||
            !jobTypeEl || !eastingEl || !northingEl
        ) {
            this.showToast('Please fill in all required fields!', 'error');
            return;
        }

        if (!jobTypeEl.value) {
            this.showToast('Please select a job type!', 'error');
            return;
        }

        const surveyNumber = surveyNumberEl.value.trim();

        const isEditing = this.editingSurveyId !== null;
        const existingSurvey = isEditing
            ? this.surveys.find(s => s.id === this.editingSurveyId)
            : null;

        if (!isEditing && this.surveys.some(s => s.surveyNumber === surveyNumber)) {
            this.showToast('Survey number already exists!', 'error');
            return;
        }

        const files = this.getSelectedMultiFiles();
        const legacyFile = this.currentFile;

        const survey = {
            id: isEditing ? this.editingSurveyId : Date.now(),
            surveyor: surveyorEl.value.trim(),
            surveyNumber,
            surveyName: surveyNameEl.value.trim(),
            area: surveyAreaEl.value,
            areaUnit: areaUnitEl.value,
            localGov: localGovEl.value,
            surveyDate: surveyDateEl.value,
            observedBy: observedByEl.value.trim(),
            jobType: jobTypeEl.value,
            easting: parseFloat(eastingEl.value),
            northing: parseFloat(northingEl.value),
            description: descriptionEl ? descriptionEl.value.trim() : '',
            remark: remarkEl ? remarkEl.value.trim() : '',
            createdBy: isEditing ? (existingSurvey?.createdBy || 'Unknown') : (this.currentUser ? this.currentUser.name : 'Unknown'),
            createdByUserId: isEditing ? (existingSurvey?.createdByUserId || null) : (this.currentUser?.id || null),
            createdByRole: isEditing ? (existingSurvey?.createdByRole || 'Unknown') : (this.currentUser?.role || 'Unknown'),
            updatedBy: this.currentUser ? this.currentUser.name : 'Unknown',
            updatedByUserId: this.currentUser?.id || null,
            createdAt: isEditing
                ? (this.surveys.find(s => s.id === this.editingSurveyId)?.createdAt || new Date().toISOString())
                : new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            hasFile: !!(files.surveyPlan || files.recordCopy || files.cod || files.other || legacyFile || this.surveyHasAnyFile(existingSurvey)),
            fileData: existingSurvey?.fileData || null,   // legacy support
            fileName: existingSurvey?.fileName || null,   // legacy support
            fileType: existingSurvey?.fileType || null,   // legacy support
            fileSize: existingSurvey?.fileSize || null,   // legacy support
            files: {
                surveyPlan: existingSurvey?.files?.surveyPlan || null,
                recordCopy: existingSurvey?.files?.recordCopy || null,
                cod: existingSurvey?.files?.cod || null,
                other: existingSurvey?.files?.other || null,
                otherDocName: files.otherDocName || existingSurvey?.files?.otherDocName || '',
                recordCopySubmitted: files.recordCopySubmitted || false
            }
        };

        try {
            // Multi-file save (base64)
            survey.files.surveyPlan = files.surveyPlan
                ? {
                    data: await this.fileToDataURL(files.surveyPlan),
                    name: files.surveyPlan.name,
                    type: files.surveyPlan.type,
                    size: files.surveyPlan.size
                }
                : survey.files.surveyPlan;

            survey.files.recordCopy = files.recordCopy
                ? {
                    data: await this.fileToDataURL(files.recordCopy),
                    name: files.recordCopy.name,
                    type: files.recordCopy.type,
                    size: files.recordCopy.size
                }
                : survey.files.recordCopy;

            survey.files.cod = files.cod
                ? {
                    data: await this.fileToDataURL(files.cod),
                    name: files.cod.name,
                    type: files.cod.type,
                    size: files.cod.size
                }
                : survey.files.cod;

            survey.files.other = files.other
                ? {
                    data: await this.fileToDataURL(files.other),
                    name: files.otherDocName || files.other.name,
                    type: files.other.type,
                    size: files.other.size
                }
                : survey.files.other;

            // Legacy single-file fallback
            if (legacyFile && !survey.files.surveyPlan && !survey.files.recordCopy && !survey.files.cod && !survey.files.other) {
                survey.fileData = await this.fileToDataURL(legacyFile);
                survey.fileName = legacyFile.name;
                survey.fileType = legacyFile.type;
                survey.fileSize = legacyFile.size;
            }

            // Update existing or add new
            if (isEditing) {
                const index = this.surveys.findIndex(s => s.id === this.editingSurveyId);
                if (index !== -1) {
                    this.surveys[index] = survey;
                }
                this.editingSurveyId = null;
                this.setSubmitButtonMode(false);
                this.showToast('Survey updated successfully!', 'success');
            } else {
                this.surveys.unshift(survey);
                this.showToast('Survey saved successfully!', 'success');
            }

            await this.saveData();
            await this.logAudit(isEditing ? 'survey_updated' : 'survey_created', 'survey', survey.id, {
                surveyNumber: survey.surveyNumber,
                surveyName: survey.surveyName,
                localGov: survey.localGov
            });
            this.clearForm();
            this.showTab('view');
        } catch (err) {
            console.error(err);
            this.showToast('Saved locally, but backend sync failed. Try again when MySQL is on.', 'warning');
        }
    },

    /**
     * Finalize survey save (kept for compatibility)
     */
    async finalizeSave(survey) {
        this.surveys.unshift(survey);
        await this.saveData();

        this.showToast('Survey saved successfully!', 'success');
        this.clearForm();
        this.showTab('view');
    },

    /**
     * Clear form
     */
    clearForm() {
        const surveyForm = this.getEl('surveyForm');
        if (surveyForm) surveyForm.reset();

        // Clear legacy file state
        this.removeFile();

        // Clear multi-file inputs
        ['fileSurveyPlan', 'fileRecordCopy', 'fileCOO', 'fileOther', 'otherDocName', 'recordCopySubmitted'].forEach(id => {
            const el = this.getEl(id);
            if (el) el.value = '';
        });
        const recordCheck = this.getEl('recordCopySubmitted');
if (recordCheck) recordCheck.checked = false;

        this.editingSurveyId = null;
        this.setSubmitButtonMode(false);
        this.setDefaultSurveyDate();
        this.updateFileStatusBadge();
    },

    /**
     * Set submit button label based on edit mode
     */
    setSubmitButtonMode(isEditing) {
        const submitBtn = this.getEl('submitSurveyBtn');
        if (submitBtn) {
            submitBtn.innerHTML = isEditing
                ? '<span>💾</span> Update Survey Record'
                : '<span>💾</span> Save Survey Record';
        }
    },

editSurvey(id) {
    const survey = this.surveys.find(s => s.id === id);
    if (!survey) return;

    this.editingSurveyId = id;
    this.setSubmitButtonMode(true);

    // Populate form fields
    this.getEl('surveyor').value = survey.surveyor || '';
    this.getEl('surveyNumber').value = survey.surveyNumber || '';
    this.getEl('surveyName').value = survey.surveyName || '';
    this.getEl('surveyArea').value = survey.area || '';
    this.getEl('areaUnit').value = survey.areaUnit || 'sqm';
    this.getEl('localGov').value = survey.localGov || '';
    this.getEl('surveyDate').value = survey.surveyDate || '';
    this.getEl('observedBy').value = survey.observedBy || '';
    this.getEl('jobType').value = survey.jobType || '';
    this.getEl('easting').value = survey.easting ?? '';
    this.getEl('northing').value = survey.northing ?? '';
    this.getEl('description').value = survey.description || '';
    this.getEl('surveyRemark').value = survey.remark || '';

    // Clear file inputs (user must re-upload if they want to change)
    ['fileSurveyPlan', 'fileRecordCopy', 'fileCOO', 'fileOther', 'otherDocName'].forEach(id => {
        const el = this.getEl(id);
        if (el) el.value = '';
    });

    // Show existing files
    const box = this.getEl('existingFilesBox');
    const files = survey.files || {};

    if (box) {
        box.innerHTML = `
            <div class="existing-files">
                <h4>Existing Documents</h4>
                ${files.surveyPlan ? `<p>📄 Survey Plan: ${files.surveyPlan.name}</p>` : ''}
                ${files.recordCopy ? `<p>📄 Record Copy: ${files.recordCopy.name}</p>` : ''}
                ${files.cod ? `<p>📄 COD: ${files.cod.name}</p>` : ''}
                ${files.other ? `<p>📄 Other: ${files.other.name}</p>` : ''}
                ${
                    (!files.surveyPlan && !files.recordCopy && !files.cod && !files.other)
                        ? `<p class="text-muted">No existing files</p>`
                        : ''
                }
            </div>
        `;
    }

    // Update badge
    this.updateFileStatusBadge();

    // Navigate to form tab
    this.showTab('add');

    // Scroll nicely to form
    setTimeout(() => {
        const tab = this.getEl('addTab');
        if (tab) {
            tab.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }, 50);

    this.showToast('Edit mode enabled. Update the fields and save.', 'success');
},
 

    /**
     * Render survey list
     */
    renderSurveyList() {
        const container = this.getEl('surveyList');
        const emptyState = this.getEl('emptyState');
        const searchInput = this.getEl('searchInput');
        const filterType = this.getEl('filterType');

        if (!container) return;

        const searchTerm = searchInput ? searchInput.value.toLowerCase() : '';
        const filterValue = filterType ? filterType.value : 'all';

        let filtered = [...this.surveys];

        if (searchTerm) {
            filtered = filtered.filter(s =>
                (s.surveyName || '').toLowerCase().includes(searchTerm) ||
                (s.surveyNumber || '').toLowerCase().includes(searchTerm) ||
                (s.surveyor || '').toLowerCase().includes(searchTerm) ||
                (s.jobType || '').toLowerCase().includes(searchTerm) ||
                (s.localGov || '').toLowerCase().includes(searchTerm) ||
                (s.surveyDate || '').toLowerCase().includes(searchTerm)
            );
        }
        if (filterValue === 'withFile') {
    filtered = filtered.filter(s => this.surveyHasAnyFile(s));
} 
        else if (filterValue === 'noFile') {
    filtered = filtered.filter(s => !this.surveyHasAnyFile(s));
} 
        else if (filterValue === 'recordSubmitted') {
    filtered = filtered.filter(
        s => s.files?.recordCopySubmitted === true
    );
}
        if (filtered.length === 0) {
            container.innerHTML = '';
            if (emptyState) emptyState.classList.remove('hidden');
            return;
        }

        if (emptyState) emptyState.classList.add('hidden');

        container.innerHTML = filtered.map(survey => {
            const fileClass = this.getFileStatusClass(survey);
            const fileLabel = this.getFileStatusLabel(survey);

            return `
                <div class="survey-card ${fileClass}" onclick="app.viewSurvey(${survey.id})">
                    <h3>
                        ${this.escapeHtml(survey.surveyName || '-')}
                        
                        ${survey.files?.recordCopySubmitted
                            ? '<span class="badge badge-success">✓ Submitted Record Copy</span>'
                            : ''
                        }
                        ${this.surveyHasAnyFile(survey)
                            ? '<span class="badge badge-success">📎 File</span>'
                            : '<span class="badge badge-secondary">No File</span>'
                        }
                    </h3>

                    <div class="survey-number">${this.escapeHtml(survey.surveyNumber || '-')}</div>

                    <div class="job-type-badge">${this.escapeHtml(fileLabel)}</div>
                    
                    <div class="survey-meta">
                        <div class="meta-item">
                            <span>👤</span>
                            <span>${this.escapeHtml(survey.surveyor || '-')}</span>
                        </div>
                        <div class="meta-item">
                            <span>📍</span>
                            <span>${this.escapeHtml(survey.localGov || '-')}</span>
                        </div>
                        <div class="meta-item">
                            <span>📅</span>
                            <span>${this.escapeHtml(survey.surveyDate || this.formatDate(survey.createdAt))}</span>
                        </div>
                        <div class="meta-item">
                            <span>🎯</span>
                            <span>E: ${Number(survey.easting || 0).toFixed(2)}</span>
                        </div>
                    </div>

                    <div class="card-actions" onclick="event.stopPropagation()">
                        <button class="btn btn-secondary btn-sm" onclick="app.viewSurvey(${survey.id})">👁 View</button>
                        <button class="btn btn-primary btn-sm" onclick="app.viewOnMap(${survey.id})">🗺 Map</button>
                        <button class="btn btn-secondary btn-sm" onclick="app.editSurvey(${survey.id})">✏ Edit</button>
                        ${this.surveyHasAnyFile(survey) ? `<button class="btn btn-secondary btn-sm" onclick="app.downloadFile(${survey.id})">⬇ Download</button>` : ''}
                    </div>
                </div>
            `;
        }).join('');
    },

    /**
     * Search surveys
     */
    searchSurveys() {
        this.renderSurveyList();
    },

    /**
     * Filter surveys
     */
    filterSurveys() {
        this.renderSurveyList();
    },

    /**
     * Determine if a survey has any file attached
     */
    surveyHasAnyFile(survey) {
        if (!survey) return false;

        if (survey.fileData) return true; // legacy

        const f = survey.files || {};
        return !!(f.surveyPlan || f.recordCopy || f.cod || f.other);
    },

    /**
     * Get file status class for cards
     */
    getFileStatusClass(survey) {
        const f = survey?.files || {};
        const hasPlan = !!f.surveyPlan;
        const hasRecord = !!f.recordCopy;
        const hasCod = !!f.cod;

        if (hasPlan && hasRecord && hasCod) return 'file-status-green';
        if (hasPlan && hasRecord) return 'file-status-yellow';
        if (hasPlan) return 'file-status-blue';
        return '';
    },

    /**
     * Get human-readable file status label
     */
    getFileStatusLabel(survey) {
        const f = survey?.files || {};
        const hasPlan = !!f.surveyPlan;
        const hasRecord = !!f.recordCopy;
        const hasCod = !!f.cod;
        const hasOther = !!f.other;

        if (hasPlan && hasRecord && hasCod) return 'All three major files';
        if (hasPlan && hasRecord) return 'Survey plan + record copy';
        if (hasPlan) return 'Survey plan attached';
        if (hasRecord || hasCod || hasOther || survey?.fileData) return 'Other file attached';
        return 'No documents';
    },

    /**
     * Get all file entries for a survey (supports new + legacy)
     */
    getSurveyFileEntries(survey) {
        if (!survey) return [];

        // Legacy single-file support
        if (survey.fileData && !survey.files) {
            return [{
                key: 'legacy',
                label: survey.fileName || 'Attached File',
                data: survey.fileData,
                name: survey.fileName || 'Attached File',
                type: survey.fileType || '',
                size: survey.fileSize || 0
            }];
        }

        const f = survey.files || {};
        const entries = [];

        if (f.surveyPlan) {
            entries.push({
                key: 'surveyPlan',
                label: 'Survey Plan',
                ...f.surveyPlan
            });
        }

        if (f.recordCopy) {
            entries.push({
                key: 'recordCopy',
                label: 'Record Copy',
                ...f.recordCopy
            });
        }

        if (f.cod) {
            entries.push({
                key: 'cod',
                label: 'Certificate of Deposit (COD)',
                ...f.cod
            });
        }

        if (f.other) {
            entries.push({
                key: 'other',
                label: f.other.name || f.otherDocName || 'Other Document',
                ...f.other
            });
        }

        return entries;
    },

    /**
     * View survey details
     */
    viewSurvey(id) {
        this.currentSurvey = this.surveys.find(s => s.id === id);
        if (!this.currentSurvey) return;

        const modalSurveyNumber = this.getEl('modalSurveyNumber');
        const modalSurveyName = this.getEl('modalSurveyName');
        const modalSurveyor = this.getEl('modalSurveyor');
        const modalArea = this.getEl('modalArea');
        const modalObservedBy = this.getEl('modalObservedBy');
        const modalJobType = this.getEl('modalJobType');
        const modalDate = this.getEl('modalDate');
        const modalEasting = this.getEl('modalEasting');
        const modalNorthing = this.getEl('modalNorthing');
        const modalDescription = this.getEl('modalDescription');
        const modalRemark = this.getEl('modalRemark');
        const modalLocalGov = this.getEl('modalLocalGov');
        const modalSurveyDate = this.getEl('modalSurveyDate');
        const modalAreaUnit = this.getEl('modalAreaUnit');

        if (modalSurveyNumber) modalSurveyNumber.textContent = this.currentSurvey.surveyNumber || '-';
        if (modalSurveyName) modalSurveyName.textContent = this.currentSurvey.surveyName || '-';
        if (modalSurveyor) modalSurveyor.textContent = this.currentSurvey.surveyor || '-';
        if (modalArea) modalArea.textContent = this.currentSurvey.area || '-';
        if (modalObservedBy) modalObservedBy.textContent = this.currentSurvey.observedBy || '-';
        if (modalJobType) modalJobType.textContent = this.getJobTypeLabel(this.currentSurvey.jobType);
        if (modalDate) modalDate.textContent = this.formatDate(this.currentSurvey.createdAt);
        if (modalEasting) modalEasting.textContent = Number(this.currentSurvey.easting || 0).toFixed(4);
        if (modalNorthing) modalNorthing.textContent = Number(this.currentSurvey.northing || 0).toFixed(4);
        if (modalDescription) modalDescription.textContent = this.currentSurvey.description || 'No location provided';
        if (modalRemark) modalRemark.textContent = this.currentSurvey.remark || 'No remarks';
        if (modalLocalGov) modalLocalGov.textContent = this.currentSurvey.localGov || '-';
        if (modalSurveyDate) modalSurveyDate.textContent = this.currentSurvey.surveyDate || '-';
        if (modalAreaUnit) modalAreaUnit.textContent = this.currentSurvey.areaUnit || '-';

        this.renderFilesInModal(this.currentSurvey);

        const surveyModal = this.getEl('surveyModal');
        if (surveyModal) surveyModal.classList.add('active');

        setTimeout(() => {
            this.initMap(this.currentSurvey.easting, this.currentSurvey.northing);
        }, 100);
    },

    /**
     * Render all documents inside the modal
     */
    renderFilesInModal(survey) {
        const fileViewer = this.getEl('fileViewer');
        const surveyPlanBox = this.getEl('viewSurveyPlan');
        const recordCopyBox = this.getEl('viewRecordCopy');
        const codBox = this.getEl('viewCOD');
        const otherBox = this.getEl('viewOther');

        if (!fileViewer) return;

        const entries = this.getSurveyFileEntries(survey);

        if (entries.length === 0) {
            fileViewer.innerHTML = '<p class="text-muted">No file attached to this survey</p>';
            return;
        }

        fileViewer.innerHTML = '';

        if (surveyPlanBox) surveyPlanBox.innerHTML = '';
        if (recordCopyBox) recordCopyBox.innerHTML = '';
        if (codBox) codBox.innerHTML = '';
        if (otherBox) otherBox.innerHTML = '';

        const targetMap = {
            surveyPlan: surveyPlanBox,
            recordCopy: recordCopyBox,
            cod: codBox,
            other: otherBox
        };

        entries.forEach(entry => {
            const block = `
                <div class="file-view-block">
                    <div class="file-view-title">${this.escapeHtml(entry.label || entry.name || 'Document')}</div>
                    <div style="font-size: 14px; color: var(--gray); margin-bottom: 8px;">
                        ${entry.size ? this.formatFileSize(entry.size) : ''}
                    </div>
                    <div class="file-actions">
                        <button class="btn btn-secondary btn-sm" onclick="app.viewDocument('${survey.id}', '${entry.key}')">View</button>
                        <button class="btn btn-primary btn-sm" onclick="app.downloadDocument('${survey.id}', '${entry.key}')">Download</button>
                    </div>
                </div>
            `;

            if (targetMap[entry.key]) {
                targetMap[entry.key].innerHTML = block;
            } else {
                fileViewer.insertAdjacentHTML('beforeend', block);
            }
        });
    },

    /**
     * Open a specific document from the modal
     */
    viewDocument(surveyId, key) {
        const survey = this.surveys.find(s => String(s.id) === String(surveyId));
        if (!survey) return;

        const entry = this.getSurveyFileEntries(survey).find(f => f.key === key);
        if (!entry || !entry.data) {
            this.showToast('Document not found.', 'error');
            return;
        }

        this.openFileData(entry.data, entry.name, entry.type);
    },

    /**
     * Download a specific document
     */
    downloadDocument(surveyId, key) {
        const survey = this.surveys.find(s => String(s.id) === String(surveyId));
        if (!survey) return;

        const entry = this.getSurveyFileEntries(survey).find(f => f.key === key);
        if (!entry || !entry.data) {
            this.showToast('Document not found.', 'error');
            return;
        }

        const link = document.createElement('a');
        link.href = entry.data;
        link.download = entry.name || 'document';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    },

    /**
     * Open file data in a new tab/window
     */
    openFileData(dataUrl, fileName = 'document', fileType = '') {
        const newWin = window.open('', '_blank');
        if (!newWin) {
            this.showToast('Popup blocked. Please allow popups for file preview.', 'warning');
            return;
        }

        const safeName = this.escapeHtml(fileName);

        if (fileType.startsWith('image/')) {
            newWin.document.write(`
                <html>
                    <head>
                        <title>${safeName}</title>
                        <style>
                            body { margin: 0; display: flex; align-items: center; justify-content: center; min-height: 100vh; background: #111827; }
                            img { max-width: 100%; max-height: 100vh; object-fit: contain; }
                        </style>
                    </head>
                    <body>
                        <img src="${dataUrl}" alt="${safeName}">
                    </body>
                </html>
            `);
        } else {
            newWin.document.write(`
                <html>
                    <head>
                        <title>${safeName}</title>
                        <style>
                            body { margin: 0; font-family: system-ui, sans-serif; }
                            .wrap { height: 100vh; display: flex; flex-direction: column; }
                            .top { padding: 12px 16px; background: #f8fafc; border-bottom: 1px solid #e2e8f0; display: flex; justify-content: space-between; align-items: center; }
                            iframe { flex: 1; width: 100%; border: 0; }
                            a { text-decoration: none; color: #4f46e5; font-weight: 600; }
                        </style>
                    </head>
                    <body>
                        <div class="wrap">
                            <div class="top">
                                <div>${safeName}</div>
                                <a href="${dataUrl}" download="${safeName}">Download</a>
                            </div>
                            <iframe src="${dataUrl}"></iframe>
                        </div>
                    </body>
                </html>
            `);
        }

        newWin.document.close();
    },

    /**
     * Close modal
     */
    closeModal() {
        const surveyModal = this.getEl('surveyModal');
        if (surveyModal) surveyModal.classList.remove('active');

        if (this.map) {
            this.map.remove();
            this.map = null;
        }

        this.currentSurvey = null;
    },

    minnaControlPoint: {
        easting: 534000.526,
        northing: 791559.851,
        lat: 7.162093,
        lng: 3.307141
    },

    minnaProjection:
        '+proj=utm +zone=31 +a=6378249.145 +rf=293.465 +towgs84=-93.6,-83.7,113.8,0,0,0,0 +units=m +no_defs +type=crs',

    /**
     * Raw Minna / UTM Zone 31N to WGS84 transform.
     */
    projectMinnaToWgs84(easting, northing) {
        const x = Number(easting);
        const y = Number(northing);

        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            return { lat: NaN, lng: NaN };
        }

        if (typeof proj4 === 'undefined') {
            console.warn('Proj4js is required for Minna / UTM Zone 31N conversion.');
            return { lat: NaN, lng: NaN };
        }

        const wgs84 = 'EPSG:4326';
        const [lng, lat] = proj4(this.minnaProjection, wgs84, [x, y]);

        return { lat, lng };
    },

    getMinnaCalibrationOffset() {
        const raw = this.projectMinnaToWgs84(
            this.minnaControlPoint.easting,
            this.minnaControlPoint.northing
        );

        if (!this.isValidLatLng(raw.lat, raw.lng)) {
            return { lat: 0, lng: 0 };
        }

        return {
            lat: this.minnaControlPoint.lat - raw.lat,
            lng: this.minnaControlPoint.lng - raw.lng
        };
    },

    /**
     * Convert Minna / UTM Zone 31N survey coordinates to calibrated WGS84 lat/lng for web maps.
     */
    convertToLatLng(easting, northing) {
        const raw = this.projectMinnaToWgs84(easting, northing);
        if (!this.isValidLatLng(raw.lat, raw.lng)) {
            return raw;
        }

        const offset = this.getMinnaCalibrationOffset();
        return {
            lat: raw.lat + offset.lat,
            lng: raw.lng + offset.lng
        };
    },

    createMapBaseLayers() {
        return {
            'Esri World Imagery': L.tileLayer(
                'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
                {
                    attribution: 'Tiles &copy; Esri'
                }
            ),
            'Esri Streets': L.tileLayer(
                'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
                {
                    attribution: 'Tiles &copy; Esri'
                }
            ),
            'OpenStreetMap': L.tileLayer(
                'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
                {
                    attribution: '&copy; OpenStreetMap contributors'
                }
            )
        };
    },

    addBaseLayers(map, defaultLayer = 'Esri World Imagery') {
        const layers = this.createMapBaseLayers();
        const selectedLayer = layers[defaultLayer] || layers['Esri World Imagery'];
        selectedLayer.addTo(map);
        L.control.layers(layers, null, { collapsed: false }).addTo(map);
        return layers;
    },

    /**
     * Initialize map
     */
    initMap(easting, northing) {
        const mapContainer = this.getEl('map');
        if (!mapContainer || typeof L === 'undefined') return;

        const { lat, lng } = this.convertToLatLng(easting, northing, 31, true);

        if (this.map) {
            this.map.remove();
            this.map = null;
        }

        this.map = L.map('map').setView([lat, lng], 16);
        this.addBaseLayers(this.map, 'Esri World Imagery');

        this.marker = L.marker([lat, lng]).addTo(this.map)
            .bindPopup(`<b>${this.escapeHtml(this.currentSurvey?.surveyName || 'Survey')}</b><br>${this.escapeHtml(this.currentSurvey?.surveyNumber || '')}`)
            .openPopup();
    },

    /**
     * View on map (shortcut)
     */
    viewOnMap(id) {
        this.viewSurvey(id);
    },

    populateAllMapFilters() {
        const surveyorFilter = this.getEl('mapSurveyorFilter');
        const lgaFilter = this.getEl('mapLgaFilter');

        if (surveyorFilter) {
            const current = surveyorFilter.value || 'all';
            const names = [...new Set(this.surveys.map(s => this.getRecordOwnerName(s)).filter(Boolean))].sort();
            surveyorFilter.innerHTML = '<option value="all">All Surveyors</option>' +
                names.map(name => `<option value="${this.escapeHtml(name)}">${this.escapeHtml(name)}</option>`).join('');
            surveyorFilter.value = names.includes(current) ? current : 'all';
        }

        if (lgaFilter) {
            const current = lgaFilter.value || 'all';
            const lgas = [...new Set(this.surveys.map(s => s.localGov).filter(Boolean))].sort();
            lgaFilter.innerHTML = '<option value="all">All LGAs</option>' +
                lgas.map(lga => `<option value="${this.escapeHtml(lga)}">${this.escapeHtml(lga)}</option>`).join('');
            lgaFilter.value = lgas.includes(current) ? current : 'all';
        }
    },

    renderAllWorkMap() {
        const mapContainer = this.getEl('allWorkMap');
        const list = this.getEl('allMapList');
        if (!mapContainer || typeof L === 'undefined') return;

        const surveyorFilter = this.getEl('mapSurveyorFilter')?.value || 'all';
        const lgaFilter = this.getEl('mapLgaFilter')?.value || 'all';
        const filteredSurveys = this.surveys.filter(survey => {
            if (!survey?.easting || !survey?.northing) return false;
            if (surveyorFilter !== 'all' && this.getRecordOwnerName(survey) !== surveyorFilter) return false;
            if (lgaFilter !== 'all' && survey.localGov !== lgaFilter) return false;
            return true;
        });
        const mappedSurveys = [];
        const unmappedSurveys = [];

        filteredSurveys.forEach(survey => {
            const coords = this.getSurveyLatLng(survey);
            if (coords) {
                mappedSurveys.push({ survey, ...coords });
            } else {
                unmappedSurveys.push(survey);
            }
        });

        if (!this.allWorkMap) {
            this.allWorkMap = L.map('allWorkMap').setView([7.1, 3.3], 8);
            this.addBaseLayers(this.allWorkMap, 'Esri World Imagery');
        }

        if (this.allWorkLayer) {
            this.allWorkLayer.clearLayers();
        } else {
            this.allWorkLayer = L.layerGroup().addTo(this.allWorkMap);
        }

        const bounds = [];
        mappedSurveys.forEach(({ survey, lat, lng }) => {
            bounds.push([lat, lng]);
            L.marker([lat, lng])
                .bindPopup(`
                    <b>${this.escapeHtml(survey.surveyName || 'Survey')}</b><br>
                    ${this.escapeHtml(survey.surveyNumber || '')}<br>
                    Inputed by ${this.escapeHtml(this.getRecordOwnerName(survey))}
                `)
                .addTo(this.allWorkLayer);
        });

        setTimeout(() => this.allWorkMap.invalidateSize(), 100);
        if (bounds.length) {
            this.allWorkMap.fitBounds(bounds, { padding: [30, 30] });
        } else {
            this.allWorkMap.setView([7.1, 3.3], 8);
        }

        if (list) {
            const mappedHtml = mappedSurveys.length
                ? mappedSurveys.map(({ survey }) => `
                    <div class="admin-row compact">
                        <div>
                            <div class="admin-row-title">${this.escapeHtml(survey.surveyNumber || '-')} - ${this.escapeHtml(survey.surveyName || '-')}</div>
                            <div class="admin-row-meta">${this.escapeHtml(survey.localGov || '-')} • Inputed by ${this.escapeHtml(this.getRecordOwnerName(survey))}</div>
                        </div>
                        <button class="btn btn-secondary btn-sm" onclick="app.viewSurvey(${survey.id})">Open</button>
                    </div>
                `).join('')
                : '<div class="admin-row"><div class="text-muted">No valid mapped survey records for this filter.</div></div>';
            const unmappedHtml = unmappedSurveys.length
                ? `
                    <div class="admin-row">
                        <div>
                            <div class="admin-row-title">Records skipped on map</div>
                            <div class="admin-row-meta">${unmappedSurveys.length} record(s) have coordinates outside valid map range. Edit their easting/northing to place them on the map.</div>
                        </div>
                    </div>
                `
                : '';
            list.innerHTML = mappedHtml + unmappedHtml;
        }
    },

    getSurveyLatLng(survey) {
        if (!survey) return null;

        const easting = Number(survey.easting);
        const northing = Number(survey.northing);
        if (!Number.isFinite(easting) || !Number.isFinite(northing)) return null;

        const converted = this.convertToLatLng(easting, northing, 31, true);
        if (this.isValidLatLng(converted.lat, converted.lng)) {
            return converted;
        }

        if (this.isValidLatLng(northing, easting)) {
            return { lat: northing, lng: easting };
        }

        return null;
    },

    isValidLatLng(lat, lng) {
        return Number.isFinite(lat) &&
            Number.isFinite(lng) &&
            lat >= -90 &&
            lat <= 90 &&
            lng >= -180 &&
            lng <= 180;
    },

    /**
     * Open in Google Maps
     */
    openInGoogleMaps() {
        if (!this.currentSurvey) return;

        const { lat, lng } = this.convertToLatLng(
            this.currentSurvey.easting,
            this.currentSurvey.northing,
            31,
            true
        );

        window.open(`https://www.google.com/maps?q=${lat},${lng}`, '_blank');
    },

    /**
     * Copy coordinates
     */
    copyCoordinates() {
        if (!this.currentSurvey) return;

        const coords = `Easting: ${this.currentSurvey.easting}, Northing: ${this.currentSurvey.northing}`;
        navigator.clipboard.writeText(coords).then(() => {
            this.showToast('Coordinates copied to clipboard!', 'success');
        }).catch(() => {
            this.showToast('Failed to copy coordinates.', 'error');
        });
    },

    /**
     * Download first available file for a survey (legacy-compatible)
     */
    downloadFile(id) {
        const survey = this.surveys.find(s => s.id === id);
        if (!survey) return;

        // Legacy
        if (survey.fileData && survey.fileName) {
            const link = document.createElement('a');
            link.href = survey.fileData;
            link.download = survey.fileName;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            return;
        }

        // New multi-file system: download first available document
        const entries = this.getSurveyFileEntries(survey);
        const first = entries.find(x => x.data);
        if (!first) {
            this.showToast('No file attached.', 'warning');
            return;
        }

        const link = document.createElement('a');
        link.href = first.data;
        link.download = first.name || 'document';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    },

    /**
     * Delete current survey
     */
    async deleteCurrentSurvey() {
        if (!this.currentSurvey) return;

        if (confirm('Are you sure you want to delete this survey record? This action cannot be undone.')) {
            this.rememberDeletedSurveyId(this.currentSurvey.id);
            this.surveys = this.surveys.filter(s => s.id !== this.currentSurvey.id);
            try {
                await this.saveData();
                await this.logAudit('survey_deleted', 'survey', this.currentSurvey.id, {
                    surveyNumber: this.currentSurvey.surveyNumber,
                    surveyName: this.currentSurvey.surveyName
                });
            } catch (error) {
                console.error(error);
                this.showToast('Record removed locally, but backend sync failed.', 'warning');
            }
            this.closeModal();
            this.renderSurveyList();
            this.showToast('Survey deleted successfully', 'success');
        }
    },

    async updateUserStatus(userId, status) {
        if (!this.isAdmin()) {
            this.showToast('Administrator access only.', 'error');
            return;
        }

        try {
            const response = await fetch(`${this.apiBaseUrl}/api/users/${userId}/status`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status, adminId: this.currentUser.id, adminName: this.currentUser.name })
            });
            const data = await response.json().catch(() => ({}));

            if (!response.ok) {
                throw new Error(data.message || 'Could not update user');
            }

            await this.loadUsers();
            await this.loadAuditLogs();
            this.renderAdminPanel();
            this.showToast(data.message, 'success');
        } catch (error) {
            this.showToast(error.message, 'error');
        }
    },

    async changeOwnPassword() {
        if (!this.currentUser?.id) return;

        const currentPassword = prompt('Enter your current password');
        if (!currentPassword) return;

        const newPassword = prompt('Enter your new password (minimum 6 characters)');
        if (!newPassword) return;

        if (newPassword.length < 6) {
            this.showToast('Password must be at least 6 characters.', 'error');
            return;
        }

        try {
            const response = await fetch(`${this.apiBaseUrl}/api/auth/change-password`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userId: this.currentUser.id,
                    currentPassword,
                    newPassword
                })
            });
            const data = await response.json().catch(() => ({}));

            if (!response.ok) {
                throw new Error(data.message || 'Could not change password');
            }

            await this.loadAuditLogs();
            this.showToast(data.message, 'success');
        } catch (error) {
            this.showToast(error.message, 'error');
        }
    },

    async resetUserPassword(userId) {
        if (!this.isAdmin()) {
            this.showToast('Administrator access only.', 'error');
            return;
        }

        const user = this.systemUsers.find(item => item.id === userId);
        const userName = user?.name || 'this user';
        const newPassword = prompt(`Enter a new password for ${userName} (minimum 6 characters)`);
        if (!newPassword) return;

        if (newPassword.length < 6) {
            this.showToast('Password must be at least 6 characters.', 'error');
            return;
        }

        try {
            const response = await fetch(`${this.apiBaseUrl}/api/users/${userId}/password`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    adminId: this.currentUser.id,
                    adminName: this.currentUser.name,
                    newPassword
                })
            });
            const data = await response.json().catch(() => ({}));

            if (!response.ok) {
                throw new Error(data.message || 'Could not reset password');
            }

            await this.loadAuditLogs();
            this.showToast(data.message, 'success');
        } catch (error) {
            this.showToast(error.message, 'error');
        }
    },

    renderAdminPanel() {
        const userList = this.getEl('adminUserList');
        const recordList = this.getEl('adminRecordList');

        if (userList) {
            if (!this.systemUsers.length) {
                userList.innerHTML = '<div class="admin-row"><div class="text-muted">No users found.</div></div>';
            } else {
                userList.innerHTML = this.systemUsers.map(user => `
                    <div class="admin-row">
                        <div>
                            <div class="admin-row-title">${this.escapeHtml(user.name)} <span class="status-pill ${this.escapeHtml(user.status)}">${this.escapeHtml(user.status)}</span></div>
                            <div class="admin-row-meta">${this.escapeHtml(user.username)} • ${this.escapeHtml(user.email || '-')} • ${this.escapeHtml(user.role)}</div>
                        </div>
                        <div class="file-actions">
                            ${user.role !== 'admin' && user.status !== 'approved' ? `<button class="btn btn-primary btn-sm" onclick="app.updateUserStatus(${user.id}, 'approved')">Approve</button>` : ''}
                            ${user.role !== 'admin' && user.status !== 'rejected' ? `<button class="btn btn-danger btn-sm" onclick="app.updateUserStatus(${user.id}, 'rejected')">Reject</button>` : ''}
                            ${user.role !== 'admin' ? `<button class="btn btn-secondary btn-sm" onclick="app.resetUserPassword(${user.id})">Reset Password</button>` : ''}
                        </div>
                    </div>
                `).join('');
            }
        }

        if (recordList) {
            const groups = new Map();
            this.surveys.forEach(survey => {
                const key = this.getRecordOwnerKey(survey);
                if (!groups.has(key)) {
                    groups.set(key, {
                        name: this.getRecordOwnerName(survey),
                        records: []
                    });
                }
                groups.get(key).records.push(survey);
            });

            const groupedSurveyors = [...groups.values()]
                .sort((a, b) => b.records.length - a.records.length);

            if (!groupedSurveyors.length) {
                recordList.innerHTML = '<div class="admin-row"><div class="text-muted">No survey records yet.</div></div>';
            } else {
                recordList.innerHTML = groupedSurveyors.map(group => `
                    <div class="admin-surveyor-group">
                        <div class="admin-group-header">
                            <div>
                                <div class="admin-row-title">${this.escapeHtml(group.name)}</div>
                                <div class="admin-row-meta">${group.records.length} job${group.records.length === 1 ? '' : 's'} inputed</div>
                            </div>
                            <span class="status-pill approved">Active Surveyor</span>
                        </div>
                        ${group.records.map(survey => `
                            <div class="admin-row compact">
                                <div>
                                    <div class="admin-row-title">${this.escapeHtml(survey.surveyNumber || '-')} - ${this.escapeHtml(survey.surveyName || '-')}</div>
                                    <div class="admin-row-meta">
                                        LGA: ${this.escapeHtml(survey.localGov || '-')} •
                                        Last updated by ${this.escapeHtml(survey.updatedBy || survey.createdBy || 'Unknown')} •
                                        ${this.escapeHtml(this.formatDate(survey.updatedAt || survey.createdAt))}
                                    </div>
                                </div>
                                <button class="btn btn-secondary btn-sm" onclick="app.viewSurvey(${survey.id})">View</button>
                            </div>
                        `).join('')}
                    </div>
                `).join('');
            }
        }
    },

    /**
     * Update analytics
     */
    updateAnalytics() {
        const now = new Date();
        const thisMonth = this.surveys.filter(s => {
            const date = new Date(s.createdAt);
            return date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear();
        });

        const totalSurveysEl = this.getEl('totalSurveys');
        const totalFilesEl = this.getEl('totalFiles');
        const activeSurveyorsEl = this.getEl('activeSurveyors');
        const thisMonthEl = this.getEl('thisMonth');

        if (totalSurveysEl) totalSurveysEl.textContent = this.surveys.length;
        if (totalFilesEl) totalFilesEl.textContent = this.surveys.filter(s => this.surveyHasAnyFile(s)).length;
        const activeSurveyorKeys = new Set(
            this.surveys
                .filter(s => s && (s.surveyNumber || s.surveyName))
                .map(s => this.getRecordOwnerKey(s))
        );
        if (activeSurveyorsEl) activeSurveyorsEl.textContent = activeSurveyorKeys.size;
        if (thisMonthEl) thisMonthEl.textContent = thisMonth.length;

        const activityList = this.getEl('activityList');
        const recent = this.surveys.slice(0, 5);

        if (activityList) {
            if (recent.length === 0) {
                activityList.innerHTML = '<div class="activity-item"><p class="text-muted">No recent activity</p></div>';
            } else {
                activityList.innerHTML = recent.map(s => `
                    <div class="activity-item">
                        <div class="activity-icon">📋</div>
                        <div class="activity-content">
                            <div class="activity-title">New survey: ${this.escapeHtml(s.surveyName || '-')}</div>
                            <div class="activity-time">by ${this.escapeHtml(s.createdBy || 'Unknown')} • ${this.timeAgo(s.createdAt)}</div>
                        </div>
                    </div>
                `).join('');
            }
        }
    },

    /**
     * Export data to CSV
     */
    exportData() {
        if (this.surveys.length === 0) {
            this.showToast('No data to export', 'warning');
            return;
        }

        const headers = [
            'Plan Number',
            'Title',
            'Surveyor',
            'Area',
            'Area Unit',
            'Local Government',
            'Survey Date',
            'Observed By',
            'Job Type',
            'Easting',
            'Northing',
            'Location',
            'Remark',
            'Created By',
            'Created Date',
            'Has File'
        ];

        const rows = this.surveys.map(s => [
            `"${s.surveyNumber || ''}"`,
            `"${s.surveyName || ''}"`,
            `"${s.surveyor || ''}"`,
            `"${s.area || ''}"`,
            `"${s.areaUnit || ''}"`,
            `"${s.localGov || ''}"`,
            `"${s.surveyDate || ''}"`,
            `"${s.observedBy || ''}"`,
            `"${this.getJobTypeLabel(s.jobType)}"`,
            s.easting ?? '',
            s.northing ?? '',
            `"${s.description || ''}"`,
            `"${s.remark || ''}"`,
            `"${s.createdBy || ''}"`,
            `"${s.createdAt || ''}"`,
            this.surveyHasAnyFile(s) ? 'Yes' : 'No'
        ]);

        const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `survey_records_${new Date().toISOString().split('T')[0]}.csv`;
        link.click();

        this.showToast('Data exported successfully!', 'success');
    },

    /**
     * Toggle theme (placeholder)
     */
    toggleTheme() {
        this.showToast('Theme toggle coming soon!', 'success');
    },

    /**
     * Show toast notification
     */
    showToast(message, type = 'success') {
        const container = this.getEl('toastContainer');
        if (!container) {
            alert(message);
            return;
        }

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;

        const icons = {
            success: '✓',
            error: '✕',
            warning: '⚠'
        };

        toast.innerHTML = `
            <span style="font-size: 20px;">${icons[type] || icons.success}</span>
            <span>${this.escapeHtml(message)}</span>
        `;

        container.appendChild(toast);

        setTimeout(() => {
            toast.remove();
        }, 3000);
    },

    /**
     * Format date
     */
    formatDate(dateString) {
        if (!dateString) return '-';
        const date = new Date(dateString);
        if (Number.isNaN(date.getTime())) return '-';

        return date.toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    },

    /**
     * Time ago
     */
    timeAgo(dateString) {
        if (!dateString) return 'Just now';

        const seconds = Math.floor((new Date() - new Date(dateString)) / 1000);

        let interval = seconds / 31536000;
        if (interval > 1) return Math.floor(interval) + ' years ago';

        interval = seconds / 2592000;
        if (interval > 1) return Math.floor(interval) + ' months ago';

        interval = seconds / 86400;
        if (interval > 1) return Math.floor(interval) + ' days ago';

        interval = seconds / 3600;
        if (interval > 1) return Math.floor(interval) + ' hours ago';

        interval = seconds / 60;
        if (interval > 1) return Math.floor(interval) + ' minutes ago';

        return 'Just now';
    },

    /**
     * Escape HTML
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text ?? '';
        return div.innerHTML;
    }
};

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    app.init();
});
