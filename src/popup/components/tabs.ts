export class Tabs {
  constructor(private readonly buttons: HTMLButtonElement[], private readonly panels: HTMLElement[]) {}

  bind() {
    this.buttons.forEach((tab, currentIndex) => {
      tab.addEventListener('click', () => this.select(tab.dataset.tab!));
      tab.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? this.buttons.length - 1
          : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + this.buttons.length) % this.buttons.length;
        const next = this.buttons[nextIndex];
        this.select(next.dataset.tab!);
        next.focus();
      });
    });
  }

  select(name: string) {
    this.buttons.forEach((tab) => {
      const active = tab.dataset.tab === name;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    this.panels.forEach((content) => {
      const active = content.id === `${name}Tab`;
      content.classList.toggle('active', active);
      content.hidden = !active;
    });
  }
}
