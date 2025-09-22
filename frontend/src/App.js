import React, { useState, useEffect, useRef, useCallback } from 'react';
import './App.css';

const API = 'http://localhost:3001';

// Simple image cache for background images
const imgCache = new Map();
async function getImage(src) {
  if (!src) return null;
  if (imgCache.has(src)) return imgCache.get(src);
  const img = new Image();
  img.crossOrigin = 'anonymous';
  const p = new Promise((resolve, reject) => { img.onload = () => resolve(img); img.onerror = reject; });
  img.src = src;
  imgCache.set(src, p);
  return p;
}

function App() {
  const [questions, setQuestions] = useState([]);
  const [answers, setAnswers] = useState({});
  const [inputText, setInputText] = useState('');
  const [selectedAnswer, setSelectedAnswer] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState('connecting');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [useImages, setUseImages] = useState(true); // reserved for future background images

  // Streaming UX flags
  const [isGenerating, setIsGenerating] = useState(false);
  const [hasPartial, setHasPartial] = useState(false);

  const eventSourceRef = useRef(null);
  const canvasRef = useRef(null);
  const animationRef = useRef(null);
  const startTimeRef = useRef(null);
  const messagesEndRef = useRef(null);

  const scrollToBottom = () => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  useEffect(() => { scrollToBottom(); }, [questions, answers]);

  // Drawing helpers
  const drawArrow = useCallback((ctx, fromX, fromY, toX, toY, color) => {
    const headLength = 15;
    const angle = Math.atan2(toY - fromY, toX - fromX);
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(fromX, fromY); ctx.lineTo(toX, toY); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(toX, toY);
    ctx.lineTo(toX - headLength * Math.cos(angle - Math.PI / 6), toY - headLength * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(toX - headLength * Math.cos(angle + Math.PI / 6), toY - headLength * Math.sin(angle + Math.PI / 6));
    ctx.closePath(); ctx.fill();
  }, []);

  const drawLayer = useCallback((ctx, type, props) => {
    ctx.save();
    try {
      if (type === 'circle') {
        ctx.beginPath();
        ctx.arc(props.x || 0, props.y || 0, Math.abs(props.r || 10), 0, 2 * Math.PI);
        if (props.fill && props.fill !== 'transparent') { ctx.fillStyle = props.fill; ctx.fill(); }
        if (props.stroke) { ctx.strokeStyle = props.stroke; ctx.lineWidth = props.strokeWidth || 1; ctx.stroke(); }
      } else if (type === 'rectangle') {
        if (props.fill && props.fill !== 'transparent') {
          ctx.fillStyle = props.fill;
          ctx.fillRect(props.x || 0, props.y || 0, props.width || 50, props.height || 30);
        }
        if (props.stroke) {
          ctx.strokeStyle = props.stroke; ctx.lineWidth = props.strokeWidth || 1;
          ctx.strokeRect(props.x || 0, props.y || 0, props.width || 50, props.height || 30);
        }
      } else if (type === 'arrow') {
        const fromX = props.x || 0, fromY = props.y || 0;
        drawArrow(ctx, fromX, fromY, fromX + (props.dx || 50), fromY + (props.dy || 0), props.color || '#000');
      } else if (type === 'text') {
        ctx.font = props.font || '16px Arial';
        ctx.fillStyle = props.color || props.fill || '#000';
        ctx.textAlign = props.textAlign || 'left';
        ctx.textBaseline = props.textBaseline || 'top';
        ctx.fillText(props.text || '', props.x || 0, props.y || 0);
      } else if (type === 'line') {
        ctx.beginPath();
        ctx.moveTo(props.x1 || 0, props.y1 || 0);
        ctx.lineTo(props.x2 || 100, props.y2 || 100);
        ctx.strokeStyle = props.color || '#000';
        ctx.lineWidth = props.lineWidth || 2;
        ctx.stroke();
      }
    } catch (e) { console.error('Draw error', e); }
    ctx.restore();
  }, [drawArrow]);

  const applyEasing = useCallback((t, easing) => {
    switch (easing) {
      case 'ease-in': return t * t;
      case 'ease-out': return 1 - Math.pow(1 - t, 2);
      case 'ease-in-out': return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      default: return t;
    }
  }, []);

  const drawVisualization = useCallback((ctx, visualization, progress) => {
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

    // Background image (if any)
    const bg = visualization.backgroundImage;
    if (bg) {
      const cached = imgCache.get(bg);
      if (cached && typeof cached.then !== 'function') {
        ctx.drawImage(cached, 0, 0, ctx.canvas.width, ctx.canvas.height);
      } else {
        getImage(bg).then(img => {
          imgCache.set(bg, img);
          ctx.drawImage(img, 0, 0, ctx.canvas.width, ctx.canvas.height);
        }).catch(() => {});
      }
    }

    if (!visualization.layers) return;
    const currentTime = progress * visualization.duration;

    visualization.layers.forEach(layer => {
      const props = { ...layer.props };
      if (layer.animations) {
        layer.animations.forEach(anim => {
          const s = anim.start || 0, e = anim.end || visualization.duration;
          if (currentTime >= s && currentTime <= e) {
            const p = (currentTime - s) / (e - s);
            const eased = applyEasing(p, anim.easing);
            if (anim.property === 'orbit') {
              const angle = 2 * Math.PI * eased;
              props.x = (anim.centerX || 0) + Math.cos(angle) * (anim.radius || 50);
              props.y = (anim.centerY || 0) + Math.sin(angle) * (anim.radius || 50);
            } else {
              const val = (anim.from ?? 0) + ((anim.to ?? 0) - (anim.from ?? 0)) * eased;
              props[anim.property] = val;
            }
          } else if (currentTime > e && anim.property !== 'orbit') {
            props[anim.property] = anim.to;
          }
        });
      }
      if (props.opacity !== undefined) ctx.globalAlpha = Math.max(0, Math.min(1, props.opacity));
      drawLayer(ctx, layer.type, props);
      ctx.globalAlpha = 1;
    });
  }, [applyEasing, drawLayer]);

  // Load history + SSE
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${API}/api/questions`);
        const result = await r.json();
        if (result.success) {
          setQuestions(result.data);
          for (const q of result.data) {
            try {
              const rr = await fetch(`${API}/api/answers/${q.answerId}`);
              const aa = await rr.json();
              if (aa.success) setAnswers(prev => ({ ...prev, [q.answerId]: aa.data }));
            } catch (e) { console.error(e); }
          }
        }
      } catch (e) { console.error(e); }
    })();

    const es = new EventSource(`${API}/api/stream`);
    eventSourceRef.current = es;
    setConnectionStatus('connecting');
    es.onopen = () => setConnectionStatus('connected');
    es.addEventListener('connected', () => setConnectionStatus('connected'));
    es.addEventListener('ping', () => {});

    es.addEventListener('question_created', (e) => {
      const q = JSON.parse(e.data);
      setQuestions(prev => (prev.some(x => x.id === q.id) ? prev : [...prev, q]));
    });

    // Progress start
    es.addEventListener('generation_started', () => {
      setIsGenerating(true);
      setHasPartial(false);
    });

    // Stream partial text as it generates
    es.addEventListener('answer_partial', (e) => {
      const p = JSON.parse(e.data); // { id, textPartial, questionId }
      setHasPartial(true);
      setAnswers(prev => ({
        ...prev,
        [p.id]: {
          id: p.id,
          text: p.textPartial,
          visualization: prev[p.id]?.visualization
        }
      }));
      setSelectedAnswer(prev => (prev?.id === p.id ? { ...prev, text: p.textPartial } : prev));
    });

    // Final answer with visualization
    es.addEventListener('answer_created', (e) => {
      const a = JSON.parse(e.data);
      setIsGenerating(false);
      setAnswers(prev => ({ ...prev, [a.id]: a }));
      setSelectedAnswer(a);
      setIsPlaying(true);
    });

    es.onerror = () => setConnectionStatus('error');
    return () => es.close();
  }, []);

  // Animation loop
  useEffect(() => {
    if (!selectedAnswer?.visualization || !isPlaying) {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
      return;
    }
    const animate = (ts) => {
      if (!startTimeRef.current) startTimeRef.current = ts;
      const elapsed = ts - startTimeRef.current;
      const duration = selectedAnswer.visualization.duration || 6000;
      const progress = Math.min(elapsed / duration, 1);
      const c = canvasRef.current;
      if (c) {
        const ctx = c.getContext('2d');
        drawVisualization(ctx, selectedAnswer.visualization, progress);
      }
      if (progress < 1 && isPlaying) animationRef.current = requestAnimationFrame(animate);
      else { setIsPlaying(false); animationRef.current = null; }
    };
    animationRef.current = requestAnimationFrame(animate);
    return () => { if (animationRef.current) cancelAnimationFrame(animationRef.current); };
  }, [selectedAnswer, isPlaying, drawVisualization]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!inputText.trim() || isSubmitting) return;
    setIsSubmitting(true);
    setIsGenerating(true);
    setHasPartial(false);
    try {
      const res = await fetch(`${API}/api/questions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'user1', question: inputText.trim() })
      });
      const out = await res.json();
      if (!out.success) alert('Failed to submit');
      else setInputText('');
    } catch (e) { console.error(e); alert('Network error'); }
    finally { setIsSubmitting(false); }
  };

  const handleAnswerClick = (a) => { setSelectedAnswer(a); setIsPlaying(false); startTimeRef.current = null; };
  const handlePlay = () => setIsPlaying(true);
  const handlePause = () => setIsPlaying(false);
  const handleReset = () => {
    setIsPlaying(false); startTimeRef.current = null;
    const c = canvasRef.current; if (c) c.getContext('2d').clearRect(0,0,c.width,c.height);
  };
  const formatTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const suggested = [
    "Explain Newton's First Law of Motion",
    "How does the solar system work?",
    "What is photosynthesis?",
    "Explain electromagnetic induction with Faraday's law"
  ];

  return (
    <div className="app">
      <div className="app-header">
        <h1>🎓 AiPrep Chat-to-Visualization</h1>
        <p>Ask any science question and get an animated explanation!</p>
        <div className="connection-status">
          <span className={`status-indicator ${connectionStatus}`}>
            {connectionStatus === 'connected' ? '🟢 Connected' : connectionStatus === 'error' ? '🔴 Connection Error' : '🟡 Connecting...'}
          </span>
        </div>
        {isGenerating && (
          <div className="progress-pulse" aria-label="Generating...">
            <div className="pulse" />
          </div>
        )}
      </div>

      <div className="app-content">
        <div className="visualization-section">
          <div className="visualization-header">
            <h3>🎬 Visualization Player</h3>
            <div className="controls">
              <button className="play-pause-btn" onClick={isPlaying ? handlePause : handlePlay} disabled={!selectedAnswer} title={isPlaying ? 'Pause' : 'Play'}>
                {isPlaying ? '⏸️' : '▶️'}
              </button>
              <button className="reset-btn" onClick={handleReset} disabled={!selectedAnswer} title="Reset">🔄</button>
              <label style={{ marginLeft: 12, fontSize: 14 }}>
                <input type="checkbox" checked={useImages} onChange={e => setUseImages(e.target.checked)} /> Use Image
              </label>
            </div>
          </div>
          <div className="visualization-container">
            {selectedAnswer ? <canvas ref={canvasRef} width={700} height={450} className="visualization-canvas" /> :
              <div className="no-visualization"><div className="placeholder-icon">🎨</div><h3>No Visualization Selected</h3><p>Ask a question to see an animated explanation!</p></div>}
          </div>
        </div>

        <div className="chat-section">
          <div className="chat-panel">
            <div className="chat-header">
              <h3>💬 Ask Questions</h3>
              <div className="stats">Questions: {questions.length} | Answers: {Object.keys(answers).length}</div>
            </div>
            <div className="chat-messages">
              {questions.length === 0 && (
                <div className="welcome-message">
                  <h4>Welcome! 👋</h4>
                  <p>Try asking one of these questions:</p>
                  <div className="suggestions">
                    {suggested.map((s, i) =>
                      <button key={i} className="suggestion-btn" onClick={() => setInputText(s)} disabled={isSubmitting}>{s}</button>
                    )}
                  </div>
                </div>
              )}
              {questions.map((q) => {
                const a = answers[q.answerId];
                const isSel = selectedAnswer?.id === a?.id;
                return (
                  <div key={q.id} className="message-group">
                    <div className="message user">
                      <div className="message-header"><span className="sender">You</span><span className="time">{formatTime(q.timestamp)}</span></div>
                      <div className="message-content">{q.question}</div>
                    </div>
                    {a ? (
                      <div className={`message assistant ${isSel ? 'selected' : ''}`} onClick={() => handleAnswerClick(a)}>
                        <div className="message-header">
                          <span className="sender">🤖 AI Tutor</span>
                          <span className="time">{formatTime(a.timestamp)}</span>
                          {isSel && <span className="selected-badge">▶️ Playing</span>}
                        </div>
                        <div className="message-content">
                          {a.text}
                          {!hasPartial && isGenerating && (
                            <span className="typing-dots" aria-label="Typing">
                              <span>.</span><span>.</span><span>.</span>
                            </span>
                          )}
                          <div className="visualization-prompt">🎬 Click to view visualization</div>
                        </div>
                      </div>
                    ) : (
                      <div className="message assistant thinking">
                        <div className="message-header"><span className="sender">🤖 AI Tutor</span></div>
                        <div className="message-content">
                          <div className="thinking-indicator"><span>Thinking</span><div className="dots"><span>.</span><span>.</span><span>.</span></div></div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>

            <form onSubmit={handleSubmit} className="chat-input-form">
              <div className="input-container">
                <textarea value={inputText} onChange={(e) => setInputText(e.target.value)} placeholder="Ask a complex topic (e.g., Explain Maxwell's equations intuitively)..." className="chat-input" disabled={isSubmitting} rows={2} />
                <button type="submit" className={`send-button ${isSubmitting ? 'sending' : ''}`} disabled={!inputText.trim() || isSubmitting}>
                  {isSubmitting ? '⏳' : '🚀'}
                </button>
              </div>
              <div className="input-hint">Press Enter to send, Shift+Enter for new line</div>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
