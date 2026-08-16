// Preferência local (por navegador) para o som das notificações. Guardada em
// localStorage — é uma escolha de UX do dispositivo, não um dado de aplicação.
const KEY = 'notif_sound_enabled';

export function isNotifSoundEnabled(): boolean {
  try {
    // Default: ligado (só desliga quando explicitamente setado como 'false').
    return localStorage.getItem(KEY) !== 'false';
  } catch {
    return true;
  }
}

export function setNotifSoundEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(KEY, enabled ? 'true' : 'false');
  } catch {
    // Sem localStorage (modo privado restrito): silenciosamente ignora.
  }
}
