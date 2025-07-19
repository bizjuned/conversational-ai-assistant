import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Room, Track } from 'livekit-client';
import './App.css'; 
import { v4 as uuidv4 } from 'uuid'; 

const LIVEKIT_URL = import.meta.env.VITE_LIVEKIT_URL || 'ws://localhost:7880';
const ROOM_NAME = 'ai-voice-bot';
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8000';
const TOKEN_ENDPOINT = `${API_BASE_URL}/api/livekit-token`;
const WS_AUDIO_ENDPOINT = `${API_BASE_URL}/api/ws/audio`;
const SSE_ENDPOINT = `${API_BASE_URL}/api/sse`;
const TEXT_CHAT_ENDPOINT = `${API_BASE_URL}/api/chat/text`;

const AUDIO_MIME_TYPE = 'audio/mpeg'; // This is typically for MP3

function App() {
  // --- State Variables ---
  const [room] = useState(() => new Room());
  const [isConnected, setIsConnected] = useState(false);
  const [connectionMessage, setConnectionMessage] = useState('Disconnected');
  const [conversation, setConversation] = useState([]);
  const [liveTranscription, setLiveTranscription] = useState('');
  const [isAiThinking, setIsAiThinking] = useState(false);
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);
  const [isMicrophoneActive, setIsMicrophoneActive] = useState(false); 
  const [textInputValue, setTextInputValue] = useState('');
  const [conversationId, setConversationId] = useState(null);

  // --- Refs ---
  const wsRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const eventSourceRef = useRef(null);
  const mediaSourceRef = useRef(null);
  const sourceBufferRef = useRef(null);
  const audioQueueRef = useRef([]);
  const audioPlayerRef = useRef(null);
  const appendingInProgressRef = useRef(false);
  const conversationEndRef = useRef(null); 
  const textareaRef = useRef(null); 
  const isTogglingMicRef = useRef(false); // NEW: Flag to prevent re-entrancy issues

  // --- Helper Functions (pure JS, no React state/props dependencies unless explicitly passed) ---
  const base64ToArrayBuffer = (base64) => {
    const binaryString = window.atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  };

  // --- Core MediaSource Playback Functions (useCallback for stability, dependencies listed) ---
  // These must be defined before initMediaSource or startResponseStream due to dependencies

  const appendAudioChunk = useCallback(() => {
    if (!sourceBufferRef.current || !audioQueueRef.current.length || appendingInProgressRef.current) {
      return;
    }

    if (sourceBufferRef.current.updating) {
      console.log("[MEDIA SOURCE] SourceBuffer is still updating. Will try again soon.");
      return;
    }

    appendingInProgressRef.current = true;
    const chunk = audioQueueRef.current.shift();
    console.log(`[MEDIA SOURCE] Appending chunk of size: ${chunk.byteLength} bytes. Remaining queue: ${audioQueueRef.current.length}`);

    try {
      sourceBufferRef.current.appendBuffer(chunk);
    } catch (e) {
      console.error("[MEDIA SOURCE] Error appending buffer:", e);
      appendingInProgressRef.current = false;
      appendAudioChunk(); // Try next chunk even if this one failed
    }
  }, []); // No external dependencies, only refs which are stable

  const onSourceBufferUpdateEnd = useCallback(() => {
    appendingInProgressRef.current = false;
    console.log("[MEDIA SOURCE] SourceBuffer update ended.");
    if (audioQueueRef.current.length > 0) {
      appendAudioChunk();
    } else {
      if (mediaSourceRef.current && mediaSourceRef.current.readyState === 'open') {
        console.log("[MEDIA SOURCE] Audio queue is empty. Waiting for more audio.");
      }
    }
  }, [appendAudioChunk]); // Depends on appendAudioChunk

  // initMediaSource is a useCallback now
  const initMediaSource = useCallback(() => {
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
        sourceBufferRef.current.onerror = (e) => { // SourceBuffer errors are caught here
          console.error("[MEDIA SOURCE] SourceBuffer error:", e);
          audioQueueRef.current = []; 
          appendingInProgressRef.current = false;
          if (mediaSourceRef.current && mediaSourceRef.current.readyState === 'open') {
            mediaSourceRef.current.endOfStream('network'); // Signal error to MediaSource
          }
          setConnectionMessage('Audio playback error. Please try again.');
        };
        appendAudioChunk(); // Try initial append if data is queued
      } catch (e) {
        console.error("[MEDIA SOURCE] Error adding SourceBuffer:", e);
        setConnectionMessage("Error: Could not setup audio playback.");
      }
    };

    mediaSourceRef.current.onsourceended = () => console.log("[MEDIA SOURCE] MediaSource ended.");
    mediaSourceRef.current.onsourceclose = () => console.log("[MEDIA SOURCE] MediaSource closed.");
  }, [audioPlayerRef, mediaSourceRef, sourceBufferRef, audioQueueRef, appendingInProgressRef, setConnectionMessage, appendAudioChunk, onSourceBufferUpdateEnd]);


  // --- Microphone & WebSocket Stream Management Functions ---
  // These must be defined before toggleMicrophone or stopAllStreams

  const stopMicrophoneStreams = useCallback(() => {
    console.log("stopMicrophoneStreams called (internal cleanup).");
    if (mediaRecorderRef.current?.state === 'recording') {
      console.log("  -> Stopping MediaRecorder explicitly (state: " + mediaRecorderRef.current.state + ").");
      try {
        mediaRecorderRef.current.stop();
      } catch (e) {
        console.warn("  -> Error stopping MediaRecorder (might already be stopped):", e);
      }
    }
    
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      console.log("  -> Closing WebSocket explicitly (state: " + wsRef.current.readyState + ").");
      try {
        wsRef.current.close();
      } catch (e) {
        console.warn("  -> Error closing WebSocket (might already be closed):", e);
      }
    }
    mediaRecorderRef.current = null;
    wsRef.current = null;

    setLiveTranscription('');
    setIsMicrophoneActive(false);
  }, []); 

  const startAudioStreamToSTT = useCallback((stream) => { 
    stopMicrophoneStreams(); // Ensure a clean slate before starting

    if (!conversationId) { 
        console.error("Cannot start audio stream: conversationId is null.");
        setConnectionMessage("Error: Missing conversation ID. Please reconnect.");
        isTogglingMicRef.current = false; // Release lock if starting fails here
        return;
    }

    try {
      const audioTrack = stream.getAudioTracks()[0];
      const clonedTrack = audioTrack.clone(); 
      const clonedStream = new MediaStream([clonedTrack]);
      
      mediaRecorderRef.current = new MediaRecorder(clonedStream, { mimeType: 'audio/webm;codecs=opus' });
      wsRef.current = new WebSocket(`${WS_AUDIO_ENDPOINT.replace('http', 'ws')}?conversation_id=${conversationId}`);

      wsRef.current.onopen = () => {
        console.log("WebSocket (for sending audio) established. Starting MediaRecorder.");
        mediaRecorderRef.current.start(200); 
        setIsMicrophoneActive(true);
        setConnectionMessage('Microphone active. Speak now...');
        setIsAiThinking(false); 
        setIsAudioPlaying(false); 
        isTogglingMicRef.current = false; // Release lock on successful start
      };

      wsRef.current.onerror = (error) => {
        console.error("WebSocket send error:", error);
        setConnectionMessage("Microphone send error. Try reconnecting.");
        stopMicrophoneStreams(); 
        isTogglingMicRef.current = false; // Release lock on error
      };

      wsRef.current.onclose = () => {
        console.log("Frontend WebSocket ONCLOSE event fired.");
        stopMicrophoneStreams(); 
        setConnectionMessage('Microphone disconnected.'); 
        isTogglingMicRef.current = false; // Release lock on close
      };

      mediaRecorderRef.current.ondataavailable = (event) => {
        if (event.data.size > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(event.data);
        }
      };

      mediaRecorderRef.current.onstop = async () => { 
        console.log("MediaRecorder ONSTOP event fired.");
        setConnectionMessage('Microphone stopped. AI is thinking...'); 
        setIsAiThinking(true); 
        // isTogglingMicRef.current is managed by ws.onclose/onerror/onopen for start/stop
      };

    } catch (err) {
      console.error("Could not start STT stream:", err);
      setConnectionMessage('Failed to start microphone: ' + err.message);
      stopMicrophoneStreams(); 
      isTogglingMicRef.current = false; // Release lock on error
    }
  }, [conversationId, stopMicrophoneStreams]);


  // --- Main Control Functions (useCallback, depend on above functions) ---

  const toggleMicrophone = useCallback(async () => {
    // Prevent multiple calls while an operation is in progress
    if (isTogglingMicRef.current) {
        console.warn("toggleMicrophone: Already toggling, ignoring re-entrant call.");
        return;
    }
    isTogglingMicRef.current = true; // Set lock

    if (!isConnected) {
        setConnectionMessage("Not connected to AI. Please connect first.");
        isTogglingMicRef.current = false; // Release lock
        return;
    }

    if (isMicrophoneActive) { // Current state is active, so user wants to STOP
      console.log("Stopping microphone recording via toggle (user action).");
      setConnectionMessage('Microphone stopping...'); 
      
      try {
        await room.localParticipant.setMicrophoneEnabled(false); 
        console.log("LiveKit microphone track disabled by user action.");
        stopMicrophoneStreams(); // This will eventually release the lock via ws.onclose
      } catch (error) {
        console.error('Failed to stop microphone:', error);
        setConnectionMessage('Failed to stop microphone: ' + error.message);
        stopMicrophoneStreams(); // Ensure cleanup even on error
      }

    } else { // Current state is inactive, so user wants to START
      console.log("Starting microphone recording via toggle (user action).");
      // Initial states set by startAudioStreamToSTT's onopen.
      // isTogglingMicRef.current is released by startAudioStreamToSTT's onopen/onerror/onclose.

      try {
        const publication = await room.localParticipant.setMicrophoneEnabled(true);
        if (!publication?.track?.mediaStream) throw new Error("Failed to get microphone track.");
        console.log('LiveKit microphone track published.');
        
        startAudioStreamToSTT(publication.track.mediaStream);
        
      } catch (error) {
        console.error('Failed to start microphone:', error);
        setConnectionMessage('Failed to start microphone: ' + error.message);
        stopMicrophoneStreams(); // Ensure cleanup on error
      }
    }
  }, [isConnected, isMicrophoneActive, room, conversationId, startAudioStreamToSTT, stopMicrophoneStreams]); 


  const stopAllStreams = useCallback(() => { 
    console.log("stopAllStreams called (full app cleanup).");
    
    stopMicrophoneStreams(); // This will also handle setting isTogglingMicRef.current to false eventually

    if (room.localParticipant.isMicrophoneEnabled) {
      room.localParticipant.setMicrophoneEnabled(false);
      console.log("LiveKit microphone track disabled.");
    }
    
    if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null; 
        console.log("SSE EventSource closed.");
    }
    
    if (mediaSourceRef.current && mediaSourceRef.current.readyState !== 'closed') {
      try {
        if (sourceBufferRef.current && mediaSourceRef.current.sourceBuffers.includes(sourceBufferRef.current)) {
          mediaSourceRef.current.removeSourceBuffer(sourceBufferRef.current);
        }
        if (mediaSourceRef.current.readyState === 'open') {
          mediaSourceRef.current.endOfStream();
        }
      } catch (e) {
        console.warn("Error ending MediaSource stream on disconnect:", e);
      }
    }
    mediaSourceRef.current = null;
    sourceBufferRef.current = null;
    audioQueueRef.current = [];
    appendingInProgressRef.current = false;

    if (audioPlayerRef.current) {
      audioPlayerRef.current.pause();
      audioPlayerRef.current.src = '';
      audioPlayerRef.current.load();
      console.log("Audio player reset.");
    }
    
    setIsConnected(false);
    setConnectionMessage('Disconnected');
    setConversation([]);
    setLiveTranscription('');
    setIsAiThinking(false);
    setIsAudioPlaying(false);
    setTextInputValue('');
    setConversationId(null); 

    console.log("All streams stopped completed.");
  }, [room, stopMicrophoneStreams]);


  const startResponseStream = useCallback(() => { 
    if (!conversationId) {
        console.error("Cannot start SSE stream: conversationId is null.");
        return;
    }
    // Only close if it's already an active connection and conversationId hasn't changed to null/undefined
    if (eventSourceRef.current) {
        // We only want to close if the ID is different, or if it's already closed.
        // If it's the *same* conversation ID, but the old connection broke,
        // eventSourceRef.current.readyState will not be OPEN, and we'll create a new one.
        if (eventSourceRef.current.url !== `${SSE_ENDPOINT}?conversation_id=${conversationId}` && eventSourceRef.current.readyState === EventSource.OPEN) {
             console.log("Closing existing EventSource due to conversationId change.");
             eventSourceRef.current.close();
             eventSourceRef.current = null;
        } else if (eventSourceRef.current.readyState === EventSource.CONNECTING || eventSourceRef.current.readyState === EventSource.OPEN) {
             console.log("SSE already connecting or open for current conversation. Skipping re-init.");
             return; // Don't re-initialize if already connected for the same convoId
        }
    }
    
    // Only create a NEW EventSource if it's currently null or closed/error
    eventSourceRef.current = new EventSource(`${SSE_ENDPOINT}?conversation_id=${conversationId}`);
    console.log(`SSE connection attempt initiated for conversation ID: ${conversationId}`);

    eventSourceRef.current.onmessage = (event) => {
      console.log("SSE MESSAGE RECEIVED FROM BACKEND:", event.data);
      try {
        const message = JSON.parse(event.data);
        
        if (message.type === 'stt_transcript_update') {
            if (!isAudioPlaying) { 
                setLiveTranscription(message.transcript);
                setIsAiThinking(true); 
            }
            console.log("Live STT Update:", message.transcript);
            return;
        }
        
        if (message.type === 'final_transcript') {
            setConversation(prev => {
                const lastUserMsg = prev.findLast(msg => msg.speaker === 'You');
                if (lastUserMsg && lastUserMsg.text === liveTranscription && liveTranscription !== '') {
                    return prev.map(msg => msg === lastUserMsg ? { ...msg, text: message.text } : msg);
                } else {
                    return [...prev, { speaker: 'You', text: message.text }];
                }
            });
            setLiveTranscription(''); 
            setIsAiThinking(true); 
            console.log("Final STT Transcript for conversation:", message.text);
            return;
        }

        if (message.type === 'ai_thinking') {
          setIsAiThinking(message.status);
          console.log("AI thinking status:", message.status);
          return;
        }

        if (message.type === 'audio_chunk') {
          setIsAiThinking(false);
          setLiveTranscription(''); 
          
          setConversation(prev => {
            const updatedConvo = [...prev];
            const lastAIMessage = updatedConvo.findLast(msg => msg.speaker === 'AI');

            if (lastAIMessage && message.llm_response_text && lastAIMessage.text !== message.llm_response_text) {
                const index = updatedConvo.lastIndexOf(lastAIMessage);
                updatedConvo[index] = { ...lastAIMessage, text: message.llm_response_text };
                return updatedConvo;
            } else if (!lastAIMessage && message.llm_response_text) {
                updatedConvo.push({ speaker: 'AI', text: message.llm_response_text });
                return updatedConvo;
            } else if (lastAIMessage && !message.llm_response_text && !lastAIMessage.text) {
                return prev;
            }
            return prev; 
          });

          const audioArrayBuffer = base64ToArrayBuffer(message.audio_chunk);
          if (audioArrayBuffer.byteLength > 0) {
              console.log(`[FRONTEND_AUDIO_RECEIVE] Base64 string length: ${message.audio_chunk.length}`);
              console.log(`[FRONTEND_AUDIO_RECEIVE] Decoded ArrayBuffer byteLength: ${audioArrayBuffer.byteLength}`);
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
        console.error("Failed to parse SSE message:", error);
      }
    };
    eventSourceRef.current.onerror = (error) => {
      console.error("SSE connection error:", error);
      // Re-establish connection on error unless explicitly disconnected by user
      if (isConnected && conversationId) { // Only attempt reconnect if still connected to app
          console.log("Attempting to re-establish SSE connection after error.");
          // Use setTimeout to avoid tight loop on immediate errors
          setTimeout(() => startResponseStream(), 1000); 
      } else {
          eventSourceRef.current.close();
          eventSourceRef.current = null; 
          setConnectionMessage('SSE connection lost. Please reconnect.');
          setIsAiThinking(false);
          setIsAudioPlaying(false);
      }
    };
  }, [conversationId, base64ToArrayBuffer, appendAudioChunk, onSourceBufferUpdateEnd, initMediaSource, setConversation, setIsAiThinking, setLiveTranscription, isAudioPlaying, isConnected]); 


  // --- Standard React Hooks (place AFTER all functions they depend on) ---
  const scrollToBottom = useCallback(() => { 
    conversationEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [conversation, liveTranscription, scrollToBottom]);

  // Main Effect for Audio Player and Component Cleanup
  useEffect(() => {
    audioPlayerRef.current = new Audio();
    audioPlayerRef.current.autoplay = true;

    const onPlay = () => setIsAudioPlaying(true);
    const onPause = () => setIsAudioPlaying(false);
    const onEnded = () => setIsAudioPlaying(false);
    
    audioPlayerRef.current.addEventListener('play', onPlay);
    audioPlayerRef.current.addEventListener('pause', onPause);
    audioPlayerRef.current.addEventListener('ended', onEnded);
    audioPlayerRef.current.addEventListener('error', (e) => {
        console.error("Audio element error:", e);
        setIsAudioPlaying(false);
        setConnectionMessage("Audio playback error. Try reconnecting.");
    });

    const cleanup = () => {
      console.log("App cleanup initiated (from useEffect).");
      stopAllStreams(); 
    };

    return cleanup;
  }, [room, stopAllStreams]);


  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'; 
      textareaRef.current.style.height = textareaRef.current.scrollHeight + 'px'; 
    }
  }, [textInputValue]); 

  useEffect(() => {
    if (conversationId) {
        startResponseStream();
    }
  }, [conversationId, startResponseStream]);

  // --- Event Handlers and API Calls ---

  const sendTextMessage = async () => {
    if (!textInputValue.trim()) return;
    if (!conversationId) { 
        setConnectionMessage("Error: Not connected. Missing conversation ID.");
        return;
    }

    setConnectionMessage('Sending text...');
    setIsAiThinking(true);
    
    setConversation(prev => [...prev, { speaker: 'You', text: textInputValue.trim() }]);
    setTextInputValue('');

    try {
      const response = await fetch(TEXT_CHAT_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: textInputValue.trim(), conversation_id: conversationId }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      console.log("Text message sent. Waiting for SSE response.");
      setConnectionMessage('Waiting for AI response...');

    } catch (error) {
      console.error("Failed to send text message:", error);
      setConnectionMessage('Error sending text: ' + error.message);
      setIsAiThinking(false); 
    }
  };

  const handleTextInputKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault(); 
      sendTextMessage();
    }
  };

  const handleConnect = async () => {
    // Prevent multiple calls while an operation is in progress
    if (isTogglingMicRef.current) { 
        console.warn("handleConnect: Already busy connecting, ignoring re-entrant call.");
        return;
    }
    isTogglingMicRef.current = true; // Set lock

    setConnectionMessage('Connecting...');
    console.log("[CONNECT] handleConnect initiated.");

    const newConversationId = uuidv4();
    setConversationId(newConversationId);
    console.log(`Generated new Conversation ID: ${newConversationId}`);

    try {
      console.log("[CONNECT] Attempting to unblock autoplay.");
      try {
        const tempAudioContext = new (window.AudioContext || window.webkitAudioContext)();
        if (tempAudioContext.state === 'suspended') {
          console.log("[CONNECT] Temporary AudioContext state: suspended. Attempting resume...");
          await tempAudioContext.resume();
          console.log("[CONNECT] Temporary AudioContext state after resume:", tempAudioContext.state);
        }
        
        const buffer = tempAudioContext.createBuffer(1, 1, tempAudioContext.sampleRate);
        const source = tempAudioContext.createBufferSource();
        source.buffer = buffer;
        source.connect(tempAudioContext.destination);
        source.start(0);
        
        source.onended = () => {
            if (tempAudioContext.state !== 'closed') {
                tempAudioContext.close();
                console.log("[CONNECT] Temporary AudioContext closed after silent play.");
            }
        };

        initMediaSource(); // This function is now defined higher up and is a useCallback
        if (audioPlayerRef.current) {
            audioPlayerRef.current.play().catch(e => {
                console.warn("Main audio element play() failed (likely non-fatal autoplay block):", e);
            });
            console.log("Main audio element play() call initiated.");
        }

      } catch (e) {
          console.warn("Autoplay unblock failed or error during initial audio play:", e);
          setConnectionMessage('Autoplay blocked. Click connect again or interact with the page.');
      }

      console.log("[CONNECT] Proceeding with LiveKit connection...");
      const response = await fetch(`${TOKEN_ENDPOINT}?room_name=${ROOM_NAME}`);
      const data = await response.json();
      const token = data.token;

      await room.connect(LIVEKIT_URL, token);
      console.log('Connected to LiveKit room.');

      const publication = await room.localParticipant.setMicrophoneEnabled(false); 
      console.log('Microphone track published (initially muted).');

      setIsConnected(true);
      setConnectionMessage('Connected. Mic is off by default. Type or click mic icon.');
      setConversation([]);
      setLiveTranscription('');
      setIsAiThinking(false);
      setIsAudioPlaying(false);
      setIsMicrophoneActive(false); 
      setTextInputValue('');
      console.log("[CONNECT] LiveKit connection and initial setup completed successfully.");

    } catch (error) {
      console.error('[CONNECT] Connection failed:', error);
      setConnectionMessage('Connection failed: ' + error.message);
      if (room.state !== 'disconnected') await room.disconnect();
    } finally {
        isTogglingMicRef.current = false; // Release lock in finally block
    }
  };

  const handleDisconnect = () => {
    stopAllStreams(); 
    if (room.state !== 'disconnected') room.disconnect();
  };

  return (
    <>
      <div className="voice-widget-container">
        <h1>AI Voice Assistant</h1>
        <p>{connectionMessage}</p>
        <div className="controls">
            {!isConnected ? (
                <button onClick={handleConnect} className="connect-button">Connect to AI</button>
            ) : (
                <>
                    <button onClick={handleDisconnect} className="disconnect-button">Disconnect</button>
                </>
            )}
        </div>
        <div className="conversation-container">
          {conversation.map((msg, index) => (
            <div key={index} className={`message ${msg.speaker.toLowerCase()}-message`}>
              <strong>{msg.speaker}:</strong> {msg.text}
            </div>
          ))}
          {liveTranscription && (
            <div className="message you-message">
              <strong>You (Live):</strong> {liveTranscription}
            </div>
          )}
          {isAiThinking && (
            <div className="status-message">AI is thinking...</div>
          )}
          {isAudioPlaying && (
            <div className="status-message">AI is speaking...</div>
          )}
          {!isConnected && !connectionMessage.includes('Connecting') && (
            <p className="status-message">Click "Connect to AI" to start.</p>
          )}
          {isConnected && !isMicrophoneActive && !liveTranscription && !isAiThinking && !isAudioPlaying && (
            <p className="status-message">Mic is off. Click microphone or type below.</p>
          )}
          <div ref={conversationEndRef} />
        </div>
        <div className="input-area">
          <textarea
            ref={textareaRef}
            value={textInputValue}
            onChange={(e) => setTextInputValue(e.target.value)}
            onKeyPress={handleTextInputKeyPress}
            placeholder="Type your message (Shift + Enter for new line, Enter to send)..."
            disabled={isMicrophoneActive || isAiThinking || isAudioPlaying}
          />
          <button onClick={sendTextMessage} disabled={isMicrophoneActive || isAiThinking || isAudioPlaying || !textInputValue.trim()} className="send-button">
            Send
          </button>
          {isConnected && (
            <button
                onClick={toggleMicrophone}
                className={`mic-button ${isMicrophoneActive ? 'active' : ''}`}
                disabled={isAiThinking || isAudioPlaying || isTogglingMicRef.current} // Disable button while toggling
                title={isMicrophoneActive ? "Stop Speaking" : "Start Speaking"}
            >
                {isMicrophoneActive ? '🔴' : '🎤'}
            </button>
          )}
        </div>

        <p className="disclaimer">
          Developed by <strong>Juned Ahsan</strong> for learning and sharing purposes.
          Powered by LLMs, Speech to Text from <strong>Deepgram</strong> and Text to Speech from <strong>ElevenLabs</strong>.
          All of these providers can be replaced in the configuration.
        </p>
      </div>
    </>
  );
}

export default App;