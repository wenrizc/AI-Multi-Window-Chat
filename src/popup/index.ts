import { PopupApp } from './app';

export const app = new PopupApp();
void app.init().catch(error => console.error(error));
