import { useEffect, useRef, useState } from 'react';
import { callKioskHandler, supabase, type KioskSession } from '../../../shared/supabase-client';

type UseCoinAcceptorArgs = {
  enabled: boolean;
  freeplay: boolean;
  playerId: string;
  session: KioskSession | null;
  onCreditsUpdated: (credits: number) => void;
  dollar1Credits?: number;
  dollar2Credits?: number;
};

export function useCoinAcceptor({
  enabled,
  freeplay,
  playerId,
  session,
  onCreditsUpdated,
  dollar1Credits = 1,
  dollar2Credits = 3,
}: UseCoinAcceptorArgs) {
  const serialPortRef = useRef<any>(null);
  const serialReaderRef = useRef<any>(null);
  const sessionRef = useRef<KioskSession | null>(null);
  const freeplayRef = useRef<boolean>(false);
  const dollar1CreditsRef = useRef<number>(dollar1Credits);
  const dollar2CreditsRef = useRef<number>(dollar2Credits);
  const [showConnectPrompt, setShowConnectPrompt] = useState(false);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    freeplayRef.current = freeplay;
  }, [freeplay]);

  useEffect(() => {
    dollar1CreditsRef.current = dollar1Credits;
  }, [dollar1Credits]);

  useEffect(() => {
    dollar2CreditsRef.current = dollar2Credits;
  }, [dollar2Credits]);

  const readCoinAcceptorData = async (reader: any) => {
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        const data = decoder.decode(value, { stream: true });
        for (const char of data) {
          let amount = 0;
          // 'b' = $1 coin, 'a' = $2 coin (hardware protocol)
          if (char === 'a') amount = dollar2CreditsRef.current;
          else if (char === 'b') amount = dollar1CreditsRef.current;

          if (amount <= 0) continue;

          if (freeplayRef.current) {
            console.log(`Coin accepted: '${char}' (freeplay - credit ignored)`);
            continue;
          }

          const currentSession = sessionRef.current;
          if (!currentSession) continue;

          const denomination = char === 'a' ? '$2' : '$1';
          console.log(`Coin accepted: ${denomination} ('${char}') -> +${amount} credit(s)`);
          const result = (await callKioskHandler({
            session_id: currentSession.session_id,
            action: 'credit',
            amount,
            source: 'coin_acceptor',
          } as any)) as { credits?: number };

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

      try {
        await (supabase as any)
          .from('player_settings')
          .update({ kiosk_coin_acceptor_connected: false, kiosk_coin_acceptor_device_id: null })
          .eq('player_id', playerId);
      } catch (err) {
        console.warn('Failed to update coin acceptor disconnect status:', err);
      }

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
      setShowConnectPrompt(false);

      try {
        await (supabase as any)
          .from('player_settings')
          .update({ kiosk_coin_acceptor_connected: true, kiosk_coin_acceptor_device_id: 'usbserial-1420' })
          .eq('player_id', playerId);
      } catch (err) {
        console.warn('Failed to update coin acceptor connect status:', err);
      }

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
        console.log('No previously-granted serial ports found — showing connect prompt.');
        setShowConnectPrompt(true);
      }
    } catch (err) {
      console.error('Auto-connect failed:', err);
    }
  };

  // Called from UI (requires user gesture for requestPort)
  const connectCoinAcceptor = async () => {
    if (!('serial' in navigator)) {
      console.warn('Web Serial API not supported in this browser');
      return;
    }
    try {
      const port = await (navigator as any).serial.requestPort();
      await openCoinAcceptorPort(port);
    } catch (err: any) {
      if (err?.name !== 'NotFoundError') {
        console.error('Failed to request serial port:', err);
      }
      // User cancelled — keep prompt visible
    }
  };

  useEffect(() => {
    if (!enabled) {
      disconnectCoinAcceptor();
      setShowConnectPrompt(false);
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

  const dismissConnectPrompt = () => setShowConnectPrompt(false);

  return { showConnectPrompt, connectCoinAcceptor, dismissConnectPrompt };
}
