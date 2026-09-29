# Локальный voice input

Кнопка микрофона в composer запускает три browser API:

- `getUserMedia({ audio: true })` получает микрофонный stream;
- Web Audio `AnalyserNode` строит waveform без сохранения аудиофайла;
- Web Speech `SpeechRecognition` преобразует голос в текст.

Forge всегда устанавливает `processLocally = true` и предварительно проверяет on-device availability. Remote speech fallback не используется. Если language pack доступен для загрузки, пользовательский клик по микрофону запускает его установку. Если локальный pack недоступен, Forge показывает ошибку и не начинает запись.

Первый клик запускает диктовку. Во время записи микрофон меняется на Stop и рядом отображается waveform. Stop завершает распознавание и добавляет финальный текст в composer; сообщение не отправляется автоматически.

В Settings можно выбрать язык системы, русский или английский. Electron разрешает только audio media permission для главного доверенного окна Forge. Камера, вложенные frames и другие permissions остаются запрещены.
