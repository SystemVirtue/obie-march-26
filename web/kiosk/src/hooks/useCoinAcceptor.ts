import { useEffect, useRef } from 'react';
import { callKioskHandler, supabase, type KioskSession } from '../../../shared/supabase-client';

type UseCoinAcceptorArgs = {
  enabled: boolean;
  freeplay: boolean;
  playerId: string;
  session: KioskSession | null;
  onCreditsUpdated: (credits: number) => void;
};

export function useCoinAcceptor({
  enabled,
  freeplay,
  playerId,
  session,
  onCreditsUpdated,
}: UseCoinAcceptorArgs) {
  const serialPortRef = useRef<any>(null);
  const serialReaderRef = useRef<any>(null);
  const sessionRef = useRef<KioskSession | null>(null);
  const freeplayRef = useRef<boolean>(false);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    freeplayRef.current = freeplay;
  }, [freeplay]);

  const readCoinAcceptorData = async (reader: any) => {
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        const data = decoder.decode(value, { stream: true });
        for (const char of data) {
          let amount = 0;
          if (char === 'a') amount = 3;
          else if (char === 'b') amount = 1;

          if (amount <= 0) continue;

          if (freeplayRef.current) {
            console.log(`Coin accepted: '${char}' (freeplay - credit ignored)`);
            continue;
          }

          const currentSession = sessionRef.current;
          if (!currentSession) continue;

          console.log(`Coin accepted: '${char}' -> +${amount} credit(s)`);
          const result = (await callKioskHandler({
            session_id: currentSession.session_id,
            action: 'credit',
            amount,
          })) as { credits?: number };

          if (result?.credits !== undefined) {
            onCreditsUpdated(result.credits);
          }
        }
      }
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        console.error('Coin acceptor read error:', err);
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // already released
      }

      serialReaderRef.current = null;

      await (supabase as any)
        .from('player_settings')
        .update({ kiosk_coin_acceptor_connected: false, kiosk_coin_acceptor_device_id: null })
        .eq('player_id', playerId);

      console.log('Coin acceptor reader closed');
    }
  };

  const openCoinAcceptorPort = async (port: any) => {
    if (serialPortRef.current === port && port.readable) return;

    try {
      serialPortRef.current = port;
      if (!port.readable) {
        await port.open({ baudRate: 9600 });
      }

      console.log('Coin acceptor connected');
      await (supabase as any)
        .from('player_settings')
        .update({ kiosk_coin_acceptor_connected: true, kiosk_coin_acceptor_device_id: 'usbserial-1420' })
        .eq('player_id', playerId);

      const reader = port.readable.getReader();
      serialReaderRef.current = reader;
      readCoinAcceptorData(reader);
    } catch (err) {
      console.error('Failed to open coin acceptor port:', err);
      serialPortRef.current = null;
    }
  };

  const disconnectCoinAcceptor = async () => {
    try {
      if (serialReaderRef.current) {
        await serialReaderRef.current.cancel();
        serialReaderRef.current = null;
      }
      if (serialPortRef.current) {
        await serialPortRef.current.close();
        serialPortRef.current = null;
      }
      console.log('Coin acceptor disconnected');
    } catch (error) {
      console.error('Failed to disconnect coin acceptor:', error);
    }
  };

  const autoConnectCoinAcceptor = async () => {
    if (!('serial' in navigator)) {
      console.warn('Web Serial API not supported in this browser');
      return;
    }

    try {
      const ports = await (navigator as any).serial.getPorts();
      if (ports.length > 0) {
        console.log(`Found ${ports.length} previously-granted serial port(s), connecting...`);
        await openCoinAcceptorPort(ports[0]);
      } else {
        console.log('No previously-granted serial ports. Connect via admin or grant permission first.');
      }
    } catch (err) {
      console.error('Auto-connect failed:', err);
    }
  };

  useEffect(() => {
    if (!enabled) {
      disconnectCoinAcceptor();
      return;
    }
    autoConnectCoinAcceptor();
  }, [enabled]);

  useEffect(() => {
    if (!('serial' in navigator)) return;

    const serial = (navigator as any).serial;

    const onConnect = (e: any) => {
      if (enabled) {
        console.log('Serial device plugged in, connecting...');
        openCoinAcceptorPort(e.target);
      }
    };

    const onDisconnect = (e: any) => {
      if (serialPortRef.current === e.target) {
        console.log('Serial device unplugged');
        serialPortRef.current = null;
      }
    };

    serial.addEventListener('connect', onConnect);
    serial.addEventListener('disconnect', onDisconnect);
    return () => {
      serial.removeEventListener('connect', onConnect);
      serial.removeEventListener('disconnect', onDisconnect);
    };
  }, [enabled]);

  useEffect(() => {
    return () => {
      disconnectCoinAcceptor();
    };
  }, []);
}
