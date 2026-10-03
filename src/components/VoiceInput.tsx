import { Mic, Square, LoaderCircle } from 'lucide-react';
import { useVoiceInput } from '../hooks/useVoiceInput';
import type { Settings } from '../../shared/types';
import { Button } from './ui';

export function VoiceInput({
  language,
  disabled,
  onTranscript,
  onError,
}: {
  language: Settings['speechLanguage'];
  disabled: boolean;
  onTranscript: (text: string) => void;
  onError: (message: string) => void;
}) {
  const voice = useVoiceInput({ language, onTranscript, onError });
  if (!voice.active)
    return (
      <Button
        className="voice-button"
        disabled={disabled}
        onClick={voice.start}
        title="Dictate with on-device speech recognition"
        aria-label="Start voice input"
      >
        <Mic size={16} />
      </Button>
    );
  return (
    <div className="voice-active" role="status" aria-label="Voice input active">
      <canvas ref={voice.canvasRef} aria-hidden="true" />
      <span>{voice.state === 'starting' ? 'Preparing local speech…' : 'Listening'}</span>
      <Button
        className="voice-button stop"
        onClick={voice.stop}
        disabled={voice.state !== 'listening'}
        title="Stop and insert transcript"
        aria-label="Stop voice input"
      >
        {voice.state === 'starting' || voice.state === 'stopping' ? (
          <LoaderCircle size={15} className="spin" />
        ) : (
          <Square size={13} />
        )}
      </Button>
    </div>
  );
}
