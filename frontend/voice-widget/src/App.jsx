import React, { useState, useEffect, useRef } from 'react';
import { Room, Track } from 'livekit-client';

const LIVEKIT_URL = import.meta.env.VITE_LIVEKIT_URL || 'ws://localhost:7880';
const ROOM_NAME = 'ai-voice-bot';
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8000';
const TOKEN_ENDPOINT = `${API_BASE_URL}/api/livekit-token`;
const WS_AUDIO_ENDPOINT = `${API_BASE_URL}/api/ws/audio`;
const SSE_ENDPOINT = `${API_BASE_URL}/api/sse`; // New SSE endpoint

function App() {
  const [room] = useState(() => new Room());
  const [isConnected, setIsConnected] = useState(false);
  const [connectionMessage, setConnectionMessage] = useState('Disconnected');
  const [conversation, setConversation] = useState([]);
  const wsRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const eventSourceRef = useRef(null); // Ref for the EventSource connection

  // Web Audio API refs
  const audioContextRef = useRef(null);
  const audioQueueRef = useRef([]);
  const audioPlayingRef = useRef(false);
  const currentSourceRef = useRef(null); // To keep track of the currently playing AudioBufferSourceNode
  const lastPlayedTimeRef = useRef(0); // To keep track of where to append next audio

  useEffect(() => {
    // Initialize AudioContext when component mounts
    audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();

    const cleanup = () => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) wsRef.current.close();
      if (eventSourceRef.current) eventSourceRef.current.close();
      if (mediaRecorderRef.current?.state === 'recording') mediaRecorderRef.current.stop();
      if (room && room.state !== 'disconnected') room.disconnect();
      if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close();
      }
    };

    return cleanup;
  }, [room]);

  // Utility to decode base64 to ArrayBuffer
  const base64ToArrayBuffer = (base64) => {
    const binaryString = window.atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  };

  // Function to play audio chunks sequentially
  const playNextAudioChunk = async () => {
    if (audioQueueRef.current.length > 0 && !audioPlayingRef.current) {
      audioPlayingRef.current = true;
      const audioBuffer = audioQueueRef.current.shift(); // Get the next chunk

      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
      }

      try {
        const decodedBuffer = await audioContextRef.current.decodeAudioData(audioBuffer);
        currentSourceRef.current = audioContextRef.current.createBufferSource();
        currentSourceRef.current.buffer = decodedBuffer;
        currentSourceRef.current.connect(audioContextRef.current.destination);

        // Calculate when to start this chunk
        const currentTime = audioContextRef.current.currentTime;
        const startTime = Math.max(currentTime, lastPlayedTimeRef.current);

        currentSourceRef.current.start(startTime);
        lastPlayedTimeRef.current = startTime + decodedBuffer.duration;

        currentSourceRef.current.onended = () => {
          currentSourceRef.current = null;
          audioPlayingRef.current = false;
          playNextAudioChunk(); // Play the next chunk when this one ends
        };
      } catch (error) {
        console.error("Error decoding or playing audio chunk:", error);
        audioPlayingRef.current = false; // Reset to allow next chunk to try
        playNextAudioChunk(); // Try playing the next one anyway
      }
    } else if (audioQueueRef.current.length === 0 && audioPlayingRef.current === false) {
      // All chunks played, reset for next response
      lastPlayedTimeRef.current = audioContextRef.current.currentTime;
    }
  };


  const startResponseStream = () => {
    eventSourceRef.current = new EventSource(SSE_ENDPOINT);
    eventSourceRef.current.onmessage = (event) => {
      console.log("SSE MESSAGE RECEIVED FROM BACKEND:", event.data);
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'audio_chunk') {
          // --- Update Conversation Display ---
          // This is a simplified way to update the conversation.
          // For a real-time display, you'd update the STT transcript as it comes in
          // and then replace it with the LLM response + audio when it's ready.
          // For now, we update only when a new audio chunk from AI arrives.
          setConversation(prev => {
            const lastMessage = prev[prev.length - 1];
            // If the last message is from AI and has the same LLM response, append only if transcript changed
            // This is to avoid repeating the LLM response text for every chunk.
            if (lastMessage && lastMessage.speaker === 'AI' && lastMessage.text === message.llm_response_text) {
              // Optionally, update the 'You' message with more accurate STT if needed
              // For simplicity, we just won't add a duplicate AI message.
              return prev; // No new text to add for AI response
            } else {
              // Add a new STT message (if it's new) and the AI response message
              let newConvo = [...prev];
              // Add user's transcript if it's new or different from the last user message
              if (!lastMessage || lastMessage.speaker !== 'You' || lastMessage.text !== message.transcript) {
                newConvo.push({ speaker: 'You', text: message.transcript });
              }
              // Add AI's LLM response
              newConvo.push({ speaker: 'AI', text: message.llm_response_text });
              return newConvo;
            }
          });

          // --- Audio Playback Logic ---
          const audioArrayBuffer = base64ToArrayBuffer(message.audio_chunk);
          audioQueueRef.current.push(audioArrayBuffer);
          playNextAudioChunk(); // Try to play if not already playing
        }
        // If you had other message types from SSE, handle them here
      } catch (error) {
        console.error("Failed to parse SSE message or process audio:", error);
      }
    };
    eventSourceRef.current.onerror = (error) => {
      console.error("SSE connection error:", error);
      eventSourceRef.current.close();
      // Potentially try to reconnect SSE here or show a user message
    };
  };

  const startAudioStreamToSTT = (stream) => {
    try {
      const audioTrack = stream.getAudioTracks()[0];
      const clonedTrack = audioTrack.clone();
      const clonedStream = new MediaStream([clonedTrack]);
      
      mediaRecorderRef.current = new MediaRecorder(clonedStream, { mimeType: 'audio/webm;codecs=opus' });
      wsRef.current = new WebSocket(WS_AUDIO_ENDPOINT.replace('http', 'ws'));

      wsRef.current.onopen = () => {
        console.log("WebSocket (for sending audio) established.");
        mediaRecorderRef.current.start(200); // Send data every 200ms
      };

      wsRef.current.onerror = (error) => console.error("WebSocket send error:", error);
      wsRef.current.onclose = () => {
        console.log("WebSocket send connection closed.");
        // Stop recorder if WebSocket closes unexpectedly
        if (mediaRecorderRef.current?.state === 'recording') {
            mediaRecorderRef.current.stop();
        }
      };

      mediaRecorderRef.current.ondataavailable = (event) => {
        if (event.data.size > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(event.data);
        }
      };
      mediaRecorderRef.current.onstop = () => {
        console.log("MediaRecorder stopped.");
        // Optionally close WebSocket when recorder stops
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.close();
        }
      };

    } catch (err) {
      console.error("Could not start STT stream:", err);
      setConnectionMessage('Microphone access failed: ' + err.message);
    }
  };

  const stopAllStreams = () => {
    if (mediaRecorderRef.current?.state === 'recording') mediaRecorderRef.current.stop();
    // No explicit close for wsRef.current here, let onclose handle it after mediaRecorder.stop()
    if (eventSourceRef.current) eventSourceRef.current.close();
    audioQueueRef.current = []; // Clear pending audio
    audioPlayingRef.current = false;
    currentSourceRef.current?.stop(); // Stop current playback
    currentSourceRef.current = null;
    lastPlayedTimeRef.current = 0;
  };
  
  const handleConnect = async () => {
    setConnectionMessage('Connecting...');
    try {
      // Ensure audio context is resumed if it was suspended (e.g., after user interaction)
      if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
        await audioContextRef.current.resume();
      }

      const response = await fetch(`${TOKEN_ENDPOINT}?room_name=${ROOM_NAME}`);
      const data = await response.json();
      const token = data.token;

      await room.connect(LIVEKIT_URL, token);
      console.log('Connected to LiveKit room.');
      
      const publication = await room.localParticipant.setMicrophoneEnabled(true);
      if (!publication?.track?.mediaStream) throw new Error("Failed to get microphone track.");
      console.log('Microphone track published.');
      
      // Initialize audio context only after user interaction
      // (This line moved up to useEffect, but resume here is important)

      startAudioStreamToSTT(publication.track.mediaStream);
      startResponseStream(); // Start listening for responses via SSE

      setIsConnected(true);
      setConnectionMessage('Connected. Speak now...');
      setConversation([]);
    } catch (error) {
      console.error('Connection failed:', error);
      setConnectionMessage('Connection failed: ' + error.message);
      if (room.state !== 'disconnected') await room.disconnect();
    }
  };

  const handleDisconnect = () => {
    stopAllStreams();
    if (room.state !== 'disconnected') room.disconnect();
    setIsConnected(false);
    setConnectionMessage('Disconnected');
    setConversation([]);
  };

  return (
    <>
      <style>{`
        /* Styling remains the same */
        .voice-widget-container { max-width: 600px; margin: 2rem auto; font-family: sans-serif; text-align: center; }
        .conversation-container { text-align: left; margin-top: 2rem; border: 1px solid #ccc; padding: 1rem; border-radius: 8px; height: 300px; overflow-y: auto; background-color: #f9f9f9; }
        .message { margin-bottom: 0.75rem; padding: 0.5rem 0.75rem; border-radius: 7px; line-height: 1.4; }
        .you-message { background-color: #e1f5fe; border: 1px solid #b3e5fc; }
        .ai-message { background-color: #f1f8e9; border: 1px solid #dcedc8; }
        button { font-size: 1rem; padding: 0.5rem 1rem; margin-top: 1rem; cursor: pointer; border-radius: 5px; border: 1px solid #ccc; }
      `}</style>
      <div className="voice-widget-container">
        <h1>AI Voice Assistant</h1>
        <p>{connectionMessage}</p>
        {!isConnected ? (
          <button onClick={handleConnect}>Connect Voice</button>
        ) : (
          <button onClick={handleDisconnect}>Disconnect</button>
        )}
        <div className="conversation-container">
          {conversation.length === 0 && isConnected && <p style={{color: '#888'}}>Listening...</p>}
          {conversation.map((msg, index) => (
            <div key={index} className={`message ${msg.speaker.toLowerCase()}-message`}>
              <strong>{msg.speaker}:</strong> {msg.text}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

export default App;