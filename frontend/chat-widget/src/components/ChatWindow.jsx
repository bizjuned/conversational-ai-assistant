// frontend/chat-widget/src/components/ChatWindow.jsx
import React, { useState, useRef } from 'react';

// Define the API URL dynamically using Vite environment variables.
// In development, this will be set in frontend/chat-widget/.env
// e.g., VITE_API_BASE_URL=http://127.0.0.1:8000
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8000';
const STREAM_ENDPOINT = `${API_BASE_URL}/api/chat/stream`;

const ChatWindow = () => {
  // State for managing chat messages (user and AI)
  const [messages, setMessages] = useState([]);
  // State for managing the user's input
  const [input, setInput] = useState('');
  // State to track if a stream is currently active (for UI feedback)
  const [isStreaming, setIsStreaming] = useState(false);
  
  // Ref to hold a reference to the AI message being streamed, 
  // allowing us to update it efficiently during the stream.
  const currentMessageRef = useRef(null);

  // Function to handle sending the message and initiating the streaming API call
  const handleSend = async (e) => {
    e.preventDefault(); 
    // Do not send if input is empty or if we are already streaming a response
    if (!input.trim() || isStreaming) return;

    const userMessage = { type: 'user', text: input };
    
    // Add user message to the messages state immediately
    setMessages(prevMessages => [...prevMessages, userMessage]);
    
    // Clear the input and set streaming status to true
    setInput('');
    setIsStreaming(true);

    try {
      // 1. Send POST request to the streaming endpoint
      const response = await fetch(STREAM_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ input: userMessage.text }),
      });

      if (!response.ok || !response.body) {
        throw new Error('Network error or failed to start stream');
      }

      // 2. Initialize a new AI message placeholder in the state
      currentMessageRef.current = { type: 'ai', text: '' };
      setMessages(prevMessages => [...prevMessages, currentMessageRef.current]);

      // 3. Read the stream in real-time
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let done = false;
      
      while (!done) {
        const { value, done: readerDone } = await reader.read();
        done = readerDone;

        if (value) {
          // Decode the received chunk (token)
          const chunk = decoder.decode(value);
          
          // Update the last message in the state with the new chunk
          setMessages(prevMessages => {
            const updatedMessages = [...prevMessages];
            const lastMessage = updatedMessages[updatedMessages.length - 1];
            
            // Append the streamed token to the bot's response text
            lastMessage.text += chunk; 
            
            return updatedMessages;
          });
        }
      }
    } catch (error) {
      console.error("Streaming error:", error);
      // Display an error message if the streaming fails
      setMessages(prevMessages => [...prevMessages, { type: 'error', text: 'Error: Could not connect to bot or stream failed.' }]);
    } finally {
      // Reset streaming status when the stream ends (success or failure)
      setIsStreaming(false);
    }
  };

  return (
    <div className="chat-container">
      {/* Messages Display Area */}
      <div className="messages-display">
        {messages.map((msg, index) => (
          <div key={index} className={`message ${msg.type}`}>
            <strong>{msg.type === 'user' ? 'You:' : 'Bot:'}</strong> {msg.text}
          </div>
        ))}
        
        {/* Simple typing indicator while the bot is streaming */}
        {isStreaming && <div className="typing-indicator">Bot is thinking...</div>}
      </div>

      {/* Input Area */}
      <form onSubmit={handleSend} className="input-area">
        <input 
          type="text" 
          value={input} 
          onChange={(e) => setInput(e.target.value)} 
          placeholder="Type a message..." 
          disabled={isStreaming}
        />
        <button type="submit" disabled={isStreaming}>
          {isStreaming ? 'Sending...' : 'Send'}
        </button>
      </form>
    </div>
  );
};

export default ChatWindow;