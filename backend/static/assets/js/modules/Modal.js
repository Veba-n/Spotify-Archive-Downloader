export const Modal = {
    activeModal: null,
    _onConfirm: null,

    show(id, onConfirm = null) {
        const modal = document.getElementById(id);
        if (!modal) return;

        modal.classList.add('show');
        this.activeModal = modal;
        this._onConfirm = onConfirm;

        // Backdrop click to close
        modal.onclick = (e) => {
            if (e.target === modal) this.hide();
        };

        const closeBtn = modal.querySelector('.modal-close');
        if (closeBtn) closeBtn.onclick = () => this.hide();

        const cancelBtn = modal.querySelector('.btn-cancel');
        if (cancelBtn) cancelBtn.onclick = () => this.hide();

        const confirmBtn = modal.querySelector('.btn-confirm');
        if (confirmBtn && onConfirm) {
            confirmBtn.onclick = async () => {
                confirmBtn.disabled = true;
                confirmBtn.textContent = '...';
                try {
                    const success = await onConfirm();
                    if (success) this.hide();
                } finally {
                    confirmBtn.disabled = false;
                    // Restore text based on button class
                    if (confirmBtn.classList.contains('destructive')) {
                        confirmBtn.textContent = 'Proceed';
                    } else {
                        confirmBtn.textContent = 'Save Changes';
                    }
                }
            };
        }
    },

    hide() {
        if (this.activeModal) {
            this.activeModal.classList.remove('show');
            this.activeModal = null;
            this._onConfirm = null;
        }
    }
};
