// frontend/chat-widget/src/App.jsx
import ChatWindow from './components/ChatWindow';
import './index.css'; 

function App() {
  return (
    <div className="app-container">
      <h1>Stream-Based AI Chatbot</h1>
      <ChatWindow />
    </div>
  );
}

export default App;