import React, { useState, useEffect, useRef } from 'react';
import { Room, Track } from 'livekit-client';

const LIVEKIT_URL = import.meta.env.VITE_LIVEKIT_URL || 'ws://localhost:7880';
const ROOM_NAME = 'ai-voice-bot';
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8000';
const TOKEN_ENDPOINT = `${API_BASE_URL}/api/livekit-token`;
const WS_AUDIO_ENDPOINT = `${API_BASE_URL}/api/ws/audio`;
const SSE_ENDPOINT = `${API_BASE_URL}/api/sse`; // New SSE endpoint

// MIME type for the audio from Eleven Labs
// MUST EXACTLY MATCH THE OUTPUT_FORMAT from backend (e.g., mp3_44100_128 -> audio/mpeg)
const AUDIO_MIME_TYPE = 'audio/mpeg';

function App() {
  const [room] = useState(() => new Room());
  const [isConnected, setIsConnected] = useState(false);
  const [connectionMessage, setConnectionMessage] = useState('Disconnected');
  const [conversation, setConversation] = useState([]);
  const wsRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const eventSourceRef = useRef(null); // Ref for the EventSource connection

  // MediaSource API refs
  const mediaSourceRef = useRef(null);
  const sourceBufferRef = useRef(null);
  const audioQueueRef = useRef([]); // Stores ArrayBuffer objects (raw audio data)
  const audioPlayerRef = useRef(null); // The <audio> element reference
  const appendingInProgressRef = useRef(false); // Flag to manage sourceBuffer.appendBuffer

  useEffect(() => {
    // Initialize the <audio> element and link it for MediaSource playback
    audioPlayerRef.current = new Audio();
    // Autoplay is set to true here as a preference, but the explicit play() call
    // in handleConnect is what actually unblocks it.
    audioPlayerRef.current.autoplay = true;

    const cleanup = () => {
      console.log("App cleanup initiated.");
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        console.log("Closing WebSocket (send audio).");
        wsRef.current.close();
      }
      if (eventSourceRef.current) {
        console.log("Closing EventSource.");
        eventSourceRef.current.close();
      }
      if (mediaRecorderRef.current?.state === 'recording') {
        console.log("Stopping MediaRecorder.");
        mediaRecorderRef.current.stop();
      }
      if (room && room.state !== 'disconnected') {
        console.log("Disconnecting LiveKit room.");
        room.disconnect();
      }

      // Cleanup MediaSource and audio player
      if (audioPlayerRef.current) {
        audioPlayerRef.current.pause();
        audioPlayerRef.current.src = ''; // Clear source
        audioPlayerRef.current.load(); // Reload to clear internal buffers
      }
      if (mediaSourceRef.current && mediaSourceRef.current.readyState !== 'closed') {
        try {
          if (mediaSourceRef.current.sourceBuffers.length > 0 && sourceBufferRef.current) {
            const existingSourceBuffer = Array.from(mediaSourceRef.current.sourceBuffers).find(sb => sb === sourceBufferRef.current);
            if (existingSourceBuffer) {
              mediaSourceRef.current.removeSourceBuffer(existingSourceBuffer);
            }
          }
          if (mediaSourceRef.current.readyState === 'open') {
             mediaSourceRef.current.endOfStream(); // Signal end of stream for cleanup
          }
        } catch (e) {
          console.warn("Error cleaning up MediaSource:", e);
        }
      }
      mediaSourceRef.current = null;
      sourceBufferRef.current = null;
      audioQueueRef.current = []; // Clear pending audio
      appendingInProgressRef.current = false;
      console.log("App cleanup completed.");
    };

    return cleanup;
  }, [room]); // room dependency ensures cleanup when room changes/disconnects

  // Utility to decode base64 to ArrayBuffer (raw audio bytes)
  const base64ToArrayBuffer = (base64) => {
    const binaryString = window.atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  };

  // Function to append audio data to the SourceBuffer
  const appendAudioChunk = () => {
    // Only proceed if sourceBuffer is ready, queue has data, and no append is in progress
    if (!sourceBufferRef.current || !audioQueueRef.current.length || appendingInProgressRef.current) {
      return;
    }

    // Check if the SourceBuffer is currently busy updating
    if (sourceBufferRef.current.updating) {
      console.log("[MEDIA SOURCE] SourceBuffer is still updating. Will try again soon.");
      return;
    }

    appendingInProgressRef.current = true; // Set flag to prevent re-entry
    const chunk = audioQueueRef.current.shift(); // Get the next chunk from the queue
    console.log(`[MEDIA SOURCE] Appending chunk of size: ${chunk.byteLength} bytes. Remaining queue: ${audioQueueRef.current.length}`);

    try {
      sourceBufferRef.current.appendBuffer(chunk); // Append the raw audio bytes
    } catch (e) {
      console.error("[MEDIA SOURCE] Error appending buffer:", e);
      // If append fails, this chunk might be bad. Clear flag and try the next one.
      appendingInProgressRef.current = false;
      appendAudioChunk(); // Try to append the next chunk immediately
    }
  };

  // Called when SourceBuffer finishes appending a chunk
  const onSourceBufferUpdateEnd = () => {
    appendingInProgressRef.current = false; // Clear flag
    console.log("[MEDIA SOURCE] SourceBuffer update ended.");
    if (audioQueueRef.current.length > 0) {
      appendAudioChunk(); // Append next chunk if available
    } else {
      // If queue is empty and MediaSource is open, consider ending stream
      if (mediaSourceRef.current && mediaSourceRef.current.readyState === 'open') {
        // This is where you'd call endOfStream() if you know the audio is definitively finished.
        // For continuous conversation, you might not call it until explicit disconnect.
        // mediaSourceRef.current.endOfStream();
        console.log("[MEDIA SOURCE] Audio queue is empty.");
      }
    }
  };

  // Initialize MediaSource for playback
  const initMediaSource = () => {
    // Only re-initialize if it's closed or null
    if (mediaSourceRef.current && mediaSourceRef.current.readyState !== 'closed') {
      console.log("[MEDIA SOURCE] MediaSource already initialized/open. Skipping re-init.");
      return;
    }
    
    if (!MediaSource.isTypeSupported(AUDIO_MIME_TYPE)) {
      console.error(`MediaSource type not supported: ${AUDIO_MIME_TYPE}`);
      setConnectionMessage(`Error: Audio format ${AUDIO_MIME_TYPE} not supported by your browser.`);
      return;
    }

    mediaSourceRef.current = new MediaSource();
    audioPlayerRef.current.src = URL.createObjectURL(mediaSourceRef.current);
    console.log("[MEDIA SOURCE] MediaSource created and linked to audio element.");

    mediaSourceRef.current.onsourceopen = () => {
      console.log("[MEDIA SOURCE] MediaSource opened.");
      try {
        sourceBufferRef.current = mediaSourceRef.current.addSourceBuffer(AUDIO_MIME_TYPE);
        sourceBufferRef.current.onupdateend = onSourceBufferUpdateEnd;
        sourceBufferRef.current.onerror = (e) => {
          console.error("[MEDIA SOURCE] SourceBuffer error:", e);
          // Attempt to recover by clearing the queue or ending the stream
          audioQueueRef.current = []; // Clear problematic chunks
          appendingInProgressRef.current = false;
          if (mediaSourceRef.current && mediaSourceRef.current.readyState === 'open') {
            mediaSourceRef.current.endOfStream('network'); // Signal error end
          }
          setConnectionMessage('Audio playback error. Please try again.');
        };
        // Start appending immediately if there's data in the queue
        appendAudioChunk();
      } catch (e) {
        console.error("[MEDIA SOURCE] Error adding SourceBuffer:", e);
        setConnectionMessage("Error: Could not setup audio playback.");
      }
    };

    mediaSourceRef.current.onsourceended = () => console.log("[MEDIA SOURCE] MediaSource ended.");
    mediaSourceRef.current.onsourceclose = () => console.log("[MEDIA SOURCE] MediaSource closed.");
  };

  const startResponseStream = () => {
    eventSourceRef.current = new EventSource(SSE_ENDPOINT);
    eventSourceRef.current.onmessage = (event) => {
      console.log("SSE MESSAGE RECEIVED FROM BACKEND:", event.data);
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'audio_chunk') {
          // --- Update Conversation Display ---
          setConversation(prev => {
            const updatedConvo = [...prev];
            let lastYouMessageIndex = -1;
            let lastAIMessageIndex = -1;

            for (let i = updatedConvo.length - 1; i >= 0; i--) {
                if (updatedConvo[i].speaker === 'You' && lastYouMessageIndex === -1) {
                    lastYouMessageIndex = i;
                }
                if (updatedConvo[i].speaker === 'AI' && lastAIMessageIndex === -1) {
                    lastAIMessageIndex = i;
                }
                if (lastYouMessageIndex !== -1 && lastAIMessageIndex !== -1) break;
            }

            if (lastYouMessageIndex !== -1 && updatedConvo[lastYouMessageIndex].text !== message.transcript) {
                updatedConvo[lastYouMessageIndex] = { speaker: 'You', text: message.transcript };
            } else if (lastYouMessageIndex === -1 || (lastYouMessageIndex !== -1 && updatedConvo[lastYouMessageIndex].text !== message.transcript)) {
                updatedConvo.push({ speaker: 'You', text: message.transcript });
            }

            if (lastAIMessageIndex === -1 || updatedConvo[lastAIMessageIndex].text !== message.llm_response_text) {
                updatedConvo.push({ speaker: 'AI', text: message.llm_response_text });
            }
            return updatedConvo;
          });

          // --- Audio Playback Logic using MediaSource ---
          const audioArrayBuffer = base64ToArrayBuffer(message.audio_chunk);
          if (audioArrayBuffer.byteLength > 0) {
              audioQueueRef.current.push(audioArrayBuffer);
              console.log(`[MEDIA SOURCE] Raw chunk queued. Current queue length: ${audioQueueRef.current.length}`);
              if (sourceBufferRef.current && !sourceBufferRef.current.updating) {
                  appendAudioChunk();
              } else {
                  console.log("[MEDIA SOURCE] SourceBuffer busy or not ready, chunk queued for later append.");
              }
          } else {
            console.warn("[MEDIA SOURCE] Received empty audioArrayBuffer from backend.");
          }

        }
      } catch (error) {
        console.error("Failed to parse SSE message or process audio:", error);
      }
    };
    eventSourceRef.current.onerror = (error) => {
      console.error("SSE connection error:", error);
      eventSourceRef.current.close();
      setConnectionMessage('SSE connection lost. Please reconnect.');
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
        console.log("WebSocket (for sending audio) established. Starting MediaRecorder.");
        mediaRecorderRef.current.start(200); // Send data every 200ms
      };

      wsRef.current.onerror = (error) => console.error("WebSocket send error:", error);
      wsRef.current.onclose = () => {
        console.log("WebSocket send connection closed.");
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
    console.log("Stopping all streams...");
    if (mediaRecorderRef.current?.state === 'recording') mediaRecorderRef.current.stop();
    if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null; // Clear ref after closing
    }
    
    // Clear and stop audio playback using MediaSource
    audioQueueRef.current = [];
    appendingInProgressRef.current = false;
    if (audioPlayerRef.current) {
      audioPlayerRef.current.pause();
      audioPlayerRef.current.src = ''; // Clear src
      audioPlayerRef.current.load(); // Reload to apply src change
    }
    if (mediaSourceRef.current && mediaSourceRef.current.readyState === 'open') {
        try {
            mediaSourceRef.current.endOfStream(); // Explicitly end the stream
        } catch (e) {
            console.warn("Error ending MediaSource stream on disconnect:", e);
        }
    }
    mediaSourceRef.current = null;
    sourceBufferRef.current = null; // Clear sourceBuffer ref as well
    console.log("All streams stopped.");
  };
  
  const handleConnect = async () => {
    setConnectionMessage('Connecting...');
    console.log("[CONNECT] handleConnect initiated.");

    try {
      // --- Step 1: Unblock browser autoplay policy ---
      console.log("[CONNECT] Attempting to unblock autoplay.");
      try {
        // Create a temporary AudioContext and play a silent sound.
        // This is often the most reliable way to unblock autoplay policies.
        const tempAudioContext = new (window.AudioContext || window.webkitAudioContext)();
        if (tempAudioContext.state === 'suspended') {
          console.log("[CONNECT] Temporary AudioContext state: suspended. Attempting resume...");
          await tempAudioContext.resume();
          console.log("[CONNECT] Temporary AudioContext state after resume:", tempAudioContext.state);
        }
        
        const buffer = tempAudioContext.createBuffer(1, 1, tempAudioContext.sampleRate); // Use context's sample rate
        const source = tempAudioContext.createBufferSource();
        source.buffer = buffer;
        source.connect(tempAudioContext.destination);
        source.start(0); // Play immediately
        
        // Close the temporary context quickly to release resources
        source.onended = () => {
            if (tempAudioContext.state !== 'closed') {
                tempAudioContext.close();
                console.log("[CONNECT] Temporary AudioContext closed after silent play.");
            }
        };

        // Now that the browser's audio engine should be unblocked,
        // initialize MediaSource and attempt to play the main audio element.
        initMediaSource(); // This creates MediaSource and sets audioPlayer.src
        if (audioPlayerRef.current) {
            // CRITICAL CHANGE: Removed 'await' here.
            // Let the play promise resolve in the background without blocking handleConnect.
            audioPlayerRef.current.play().catch(e => {
                console.warn("Main audio element play() failed (likely non-fatal autoplay block):", e);
                console.error(e); // Log the full error object/stack
            });
            console.log("Main audio element play() call initiated.");
        }

      } catch (e) {
          console.warn("Autoplay unblock failed or error during initial audio play:", e);
          console.error(e); // Log the full error object/stack
          setConnectionMessage('Autoplay blocked. Click connect again or interact with the page.');
      }

      console.log("[CONNECT] Proceeding with LiveKit connection...");
      const response = await fetch(`${TOKEN_ENDPOINT}?room_name=${ROOM_NAME}`);
      const data = await response.json();
      const token = data.token;

      await room.connect(LIVEKIT_URL, token);
      console.log('Connected to LiveKit room.');

      const publication = await room.localParticipant.setMicrophoneEnabled(true);
      if (!publication?.track?.mediaStream) throw new Error("Failed to get microphone track.");
      console.log('Microphone track published.');

      startAudioStreamToSTT(publication.track.mediaStream);
      startResponseStream(); // Start listening for responses via SSE

      setIsConnected(true);
      setConnectionMessage('Connected. Speak now...');
      setConversation([]);
      console.log("[CONNECT] handleConnect completed successfully.");

    } catch (error) {
      console.error('[CONNECT] Connection failed:', error); // Explicitly log where it failed
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
        {/* The hidden audio element that MediaSource will control */}
        <audio ref={audioPlayerRef} style={{display: 'none'}} />
      </div>
    </>
  );
}

export default App;