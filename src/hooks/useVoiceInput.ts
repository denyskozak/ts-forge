import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

type RecognitionResultEvent = Event & {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
};
type RecognitionErrorEvent = Event & { error: string; message?: string };
type LocalSpeechRecognition = EventTarget & {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  processLocally: boolean;
  onresult: ((event: RecognitionResultEvent) => void) | null;
  onerror: ((event: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};
type SpeechRecognitionConstructor = {
  new (): LocalSpeechRecognition;
  available?: (options: { langs: string[]; processLocally: boolean }) => Promise<string>;
  install?: (options: { langs: string[] }) => Promise<boolean>;
};

const speechConstructor = () =>
  (
    globalThis as typeof globalThis & {
      SpeechRecognition?: SpeechRecognitionConstructor;
      webkitSpeechRecognition?: SpeechRecognitionConstructor;
    }
  ).SpeechRecognition ??
  (
    globalThis as typeof globalThis & {
      webkitSpeechRecognition?: SpeechRecognitionConstructor;
    }
  ).webkitSpeechRecognition;

export function useVoiceInput({
  language,
  onTranscript,
  onError,
}: {
  language: 'auto' | 'ru-RU' | 'en-US';
  onTranscript: (text: string) => void;
  onError: (message: string) => void;
}) {
  const [state, setState] = useState<'idle' | 'starting' | 'listening' | 'stopping'>('idle');
  const recognitionRef = useRef<LocalSpeechRecognition | undefined>(undefined);
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const audioRef = useRef<AudioContext | undefined>(undefined);
  const animationRef = useRef<number | undefined>(undefined);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const transcriptRef = useRef('');
  const interimRef = useRef('');
  const stoppingRef = useRef(false);

  const stopVisualization = useCallback(() => {
    if (animationRef.current) cancelAnimationFrame(animationRef.current);
    animationRef.current = undefined;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = undefined;
    void audioRef.current?.close().catch(() => {});
    audioRef.current = undefined;
  }, []);

  const finish = useCallback(() => {
    stopVisualization();
    recognitionRef.current = undefined;
    const transcript = `${transcriptRef.current} ${interimRef.current}`.trim();
    transcriptRef.current = '';
    interimRef.current = '';
    stoppingRef.current = false;
    setState('idle');
    if (transcript) onTranscript(transcript);
  }, [onTranscript, stopVisualization]);

  const drawWaveform = useCallback((analyser: AnalyserNode) => {
    const canvas = canvasRef.current;
    if (!canvas) {
      animationRef.current = requestAnimationFrame(() => drawWaveform(analyser));
      return;
    }
    const context = canvas.getContext('2d');
    if (!context) return;
    const samples = new Uint8Array(analyser.frequencyBinCount);
    const draw = () => {
      analyser.getByteFrequencyData(samples);
      const ratio = window.devicePixelRatio || 1;
      const width = canvas.clientWidth * ratio;
      const height = canvas.clientHeight * ratio;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      context.clearRect(0, 0, width, height);
      context.fillStyle = '#c79b78';
      const bars = 22;
      const gap = 2 * ratio;
      const barWidth = Math.max(1, (width - gap * (bars - 1)) / bars);
      for (let index = 0; index < bars; index++) {
        const sample = samples[Math.floor((index / bars) * samples.length)] / 255;
        const barHeight = Math.max(2 * ratio, sample * height * 0.9);
        context.globalAlpha = 0.45 + sample * 0.55;
        context.fillRect(index * (barWidth + gap), (height - barHeight) / 2, barWidth, barHeight);
      }
      context.globalAlpha = 1;
      animationRef.current = requestAnimationFrame(draw);
    };
    draw();
  }, []);

  const start = useCallback(async () => {
    const Recognition = speechConstructor();
    if (!Recognition) {
      onError('On-device speech recognition is not available in this Electron build.');
      return;
    }
    const lang = language === 'auto' ? navigator.language || 'en-US' : language;
    setState('starting');
    try {
      if (!Recognition.available)
        throw new Error('This Chromium build cannot verify on-device speech recognition.');
      let availability = await Recognition.available({ langs: [lang], processLocally: true });
      if (availability === 'downloadable' && Recognition.install) {
        const installed = await Recognition.install({ langs: [lang] });
        if (installed)
          availability = await Recognition.available({ langs: [lang], processLocally: true });
      }
      if (availability !== 'available')
        throw new Error(`The on-device speech pack for ${lang} is ${availability}.`);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      const audio = new AudioContext();
      const analyser = audio.createAnalyser();
      analyser.fftSize = 128;
      analyser.smoothingTimeConstant = 0.72;
      audio.createMediaStreamSource(stream).connect(analyser);
      streamRef.current = stream;
      audioRef.current = audio;
      drawWaveform(analyser);

      const recognition = new Recognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = lang;
      recognition.processLocally = true;
      recognition.onresult = (event) => {
        let interim = '';
        for (let index = event.resultIndex; index < event.results.length; index++) {
          const result = event.results[index];
          if (result.isFinal) transcriptRef.current += `${result[0].transcript} `;
          else interim += result[0].transcript;
        }
        interimRef.current = interim;
      };
      recognition.onerror = (event) => {
        if (stoppingRef.current && event.error === 'aborted') return;
        onError(
          event.error === 'no-speech'
            ? 'No speech was detected.'
            : `Voice recognition failed: ${event.message || event.error}.`,
        );
      };
      recognition.onend = finish;
      recognitionRef.current = recognition;
      recognition.start();
      setState('listening');
    } catch (error) {
      stopVisualization();
      setState('idle');
      onError((error as Error).message);
    }
  }, [drawWaveform, finish, language, onError, stopVisualization]);

  const stop = useCallback(() => {
    if (!recognitionRef.current) return;
    stoppingRef.current = true;
    setState('stopping');
    recognitionRef.current.stop();
  }, []);

  useEffect(
    () => () => {
      recognitionRef.current?.abort();
      stopVisualization();
    },
    [stopVisualization],
  );

  return {
    canvasRef: canvasRef as RefObject<HTMLCanvasElement>,
    state,
    active: state !== 'idle',
    start,
    stop,
  };
}
