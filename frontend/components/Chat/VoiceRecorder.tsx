import React, { useState, useRef, useEffect } from 'react';
import { IconMicrophone, IconPlayerStop, IconX, IconSend } from '@tabler/icons-react';

interface VoiceRecorderProps {
  onRecordingComplete: (audioBlob: Blob, transcript?: string) => void;
  onCancel: () => void;
}

export const VoiceRecorder: React.FC<VoiceRecorderProps> = ({
  onRecordingComplete,
  onCancel,
}) => {
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [audioLevel, setAudioLevel] = useState(0);
  const [transcript, setTranscript] = useState('');

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const recognitionRef = useRef<any>(null);

  useEffect(() => {
    // Start recording immediately when component mounts
    startRecording();

    return () => {
      stopRecording();
      if (timerRef.current) clearInterval(timerRef.current);
      if (audioContextRef.current) audioContextRef.current.close();
    };
  }, []);

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // Setup media recorder
      mediaRecorderRef.current = new MediaRecorder(stream);
      audioChunksRef.current = [];

      mediaRecorderRef.current.ondataavailable = (event) => {
        audioChunksRef.current.push(event.data);
      };

      mediaRecorderRef.current.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        onRecordingComplete(audioBlob, transcript);
      };

      // Setup audio visualization
      audioContextRef.current = new AudioContext();
      const source = audioContextRef.current.createMediaStreamSource(stream);
      analyserRef.current = audioContextRef.current.createAnalyser();
      analyserRef.current.fftSize = 256;
      source.connect(analyserRef.current);

      // Start recording
      mediaRecorderRef.current.start();
      setIsRecording(true);

      // Start timer
      timerRef.current = setInterval(() => {
        setRecordingTime(prev => prev + 1);

        // Update audio level
        if (analyserRef.current) {
          const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
          analyserRef.current.getByteFrequencyData(dataArray);
          const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
          setAudioLevel(average / 255);
        }
      }, 100);

      // Setup speech recognition if available
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (SpeechRecognition) {
        recognitionRef.current = new SpeechRecognition();
        recognitionRef.current.continuous = true;
        recognitionRef.current.interimResults = true;

        recognitionRef.current.onresult = (event: any) => {
          const transcript = Array.from(event.results)
            .map((result: any) => result[0].transcript)
            .join(' ');
          setTranscript(transcript);
        };

        recognitionRef.current.start();
      }

      // Haptic feedback
      if ('vibrate' in navigator) {
        navigator.vibrate(50);
      }
    } catch (error) {
      console.error('Failed to start recording:', error);
      onCancel();
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
      setIsRecording(false);

      if (timerRef.current) {
        clearInterval(timerRef.current);
      }

      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
    }
  };

  const handleCancel = () => {
    stopRecording();
    onCancel();
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-sm animate-fade-in">
      <div className="relative w-full max-w-sm mx-4">
        {/* Cancel button */}
        <button
          onClick={handleCancel}
          className="absolute -top-12 right-0 text-white/60 hover:text-white transition-colors"
          aria-label="Cancel recording"
        >
          <IconX size={24} />
        </button>

        <div className="glass-strong rounded-3xl shadow-2xl p-6 animate-scale-in">
          {/* Recording indicator */}
          <div className="flex flex-col items-center">
            <div className="relative mb-6">
              {/* Pulsing rings */}
              {isRecording && (
                <>
                  <div className="absolute inset-0 rounded-full bg-red-500 opacity-20 animate-ping" />
                  <div className="absolute inset-0 rounded-full bg-red-500 opacity-10 animate-ping animation-delay-200" />
                </>
              )}

              {/* Microphone button with level indicator */}
              <div
                className="relative w-24 h-24 rounded-full bg-red-500 flex items-center justify-center"
                style={{
                  transform: `scale(${1 + audioLevel * 0.2})`,
                  transition: 'transform 0.1s ease-out',
                }}
              >
                <IconMicrophone size={40} className="text-white" />
              </div>
            </div>

            {/* Recording time */}
            <div className="text-2xl font-mono text-gray-800 dark:text-gray-200 mb-2">
              {formatTime(Math.floor(recordingTime / 10))}
            </div>

            {/* Transcript preview */}
            {transcript && (
              <div className="w-full mb-4 p-3 glass rounded-lg max-h-32 overflow-y-auto animate-slide-in">
                <p className="text-sm text-gray-700 dark:text-gray-300">{transcript}</p>
              </div>
            )}

            {/* Waveform visualization */}
            <div className="w-full h-16 mb-6 flex items-center justify-center gap-1">
              {Array.from({ length: 20 }).map((_, i) => (
                <div
                  key={i}
                  className="w-1 bg-red-500 rounded-full transition-all duration-100"
                  style={{
                    height: `${Math.max(4, audioLevel * 64 * Math.random())}px`,
                  }}
                />
              ))}
            </div>

            {/* Action buttons */}
            <div className="flex gap-4">
              <button
                onClick={handleCancel}
                className="px-6 py-3 rounded-full bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={stopRecording}
                className="px-6 py-3 rounded-full bg-nvidia-green text-white hover:bg-nvidia-green-dark transition-colors flex items-center gap-2"
              >
                <IconPlayerStop size={20} />
                Send
              </button>
            </div>
          </div>
        </div>

        {/* Instructions */}
        <p className="text-center text-white/60 text-sm mt-4">
          Tap to stop recording • Max 2 minutes
        </p>
      </div>
    </div>
  );
};
