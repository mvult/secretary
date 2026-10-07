import { useEffect } from 'react';
import { getWhatsAppStatus } from '../../lib/backend';

export function useWhatsAppUpdateNotification(backendUrl: string, authToken: string) {
  useEffect(() => {
    if (!authToken || !backendUrl.trim()) return;
    let cancelled = false;
    let inFlight = false;
    async function poll() {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        // This only reads the backend's cached daily check; it never checks upstream.
        const { status } = await getWhatsAppStatus(backendUrl, authToken);
        const update = status.library_update;
        if (cancelled || !update?.available || !('Notification' in window)) return;
        const key = `secretary:whatsapp-update:${JSON.stringify([backendUrl.trim().replace(/\/$/, ''), update.latest])}`;
        if (localStorage.getItem(key)) return;
        let permission = Notification.permission;
        if (permission === 'default') permission = await Notification.requestPermission();
        if (cancelled || permission !== 'granted') return;
        new Notification('WhatsApp integration update available', {
          body: `WhatsMeow ${update.latest} is available for ${backendUrl}. Update the backend dependency and redeploy.`,
          tag: key,
        });
        localStorage.setItem(key, 'notified');
      } catch (error) {
        console.warn('WhatsApp update notification failed', error);
      } finally {
        inFlight = false;
      }
    }
    void poll();
    const timer = window.setInterval(() => void poll(), 60000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [backendUrl, authToken]);
}
