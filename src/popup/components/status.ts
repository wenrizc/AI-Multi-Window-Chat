/** Per-instance timers keep unrelated status regions independent. */
export class StatusMessages {
  private statusTimers = new Map<HTMLElement, number>();

  dispose() {
    this.statusTimers.forEach(timer => window.clearTimeout(timer));
    this.statusTimers.clear();
  }

  show(target: HTMLElement, text: string, type: 'success' | 'error') {
    this.clearTimer(target);
    target.textContent = text;
    target.className = `status show ${type}`;
    target.setAttribute('role', type === 'error' ? 'alert' : 'status');
    if (type === 'success') {
      const timer = window.setTimeout(() => {
        target.classList.remove('show');
        this.statusTimers.delete(target);
      }, 3200);
      this.statusTimers.set(target, timer);
    }
  }

  clearTimer(target: HTMLElement) {
    const timer = this.statusTimers.get(target);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      this.statusTimers.delete(target);
    }
  }
}
