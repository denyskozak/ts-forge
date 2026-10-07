import { Mic, Square, LoaderCircle } from 'lucide-react';
import { useVoiceInput } from '../hooks/useVoiceInput';
import { SPEECH_LANGUAGES, type Settings } from '../../shared/types';

export function VoiceInput({
  language,
  disabled,
  onLanguageChange,
  onTranscript,
  onError,
}: {
  language: Settings['speechLanguage'];
  disabled: boolean;
  onLanguageChange: (language: Settings['speechLanguage']) => void;
  onTranscript: (text: string) => void;
  onError: (message: string) => void;
}) {
  const voice = useVoiceInput({ language, onTranscript, onError });
  const displayLanguage = language === 'en-US' ? 'auto' : language;
  const selected =
    SPEECH_LANGUAGES.find((item) => item.value === displayLanguage) ?? SPEECH_LANGUAGES[0];
  return (
    <div className="voice-controls">
      <select
        className="voice-language"
        aria-label="Voice language"
        title={`Voice language: ${selected.label}`}
        value={displayLanguage}
        disabled={disabled || voice.active}
        onChange={(event) => onLanguageChange(event.target.value as Settings['speechLanguage'])}
      >
        {SPEECH_LANGUAGES.map((item) => (
          <option key={item.value} value={item.value} title={item.label} aria-label={item.label}>
            {item.code}
          </option>
        ))}
      </select>
      {!voice.active ? (
        <button
          className="voice-button"
          disabled={disabled}
          onClick={voice.start}
          title={`Dictate in ${selected.label} on this device`}
          aria-label="Start voice input"
        >
          <Mic size={16} />
        </button>
      ) : (
        <div className="voice-active" role="status" aria-label="Voice input active">
          <canvas ref={voice.canvasRef} aria-hidden="true" />
          <span>{voice.state === 'starting' ? `Preparing ${selected.code}…` : 'Listening'}</span>
          <button
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
          </button>
        </div>
      )}
    </div>
  );
}
