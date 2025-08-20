import React, { useEffect, useState } from 'react';
import { io, Socket } from 'socket.io-client';

type CardRank = 'A' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K';

type VisiblePlayer = { id: string; name: string; isHost: boolean; cardsLeft: number };
type VisibleState = {
  id: string;
  players: VisiblePlayer[];
  started: boolean;
  currentTurnPlayerId?: string;
  currentRequiredRank: CardRank;
  lastPlay: { username: string; count: number; claimedRank: CardRank } | null;
  pileCount: number;
  bsWindowUntil: number | null;
};

const serverUrl = import.meta.env.VITE_SERVER_URL || 'http://localhost:4000';

export function App() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [username, setUsername] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [state, setState] = useState<VisibleState | null>(null);
  const [myPlayerId, setMyPlayerId] = useState('');
  const [hand, setHand] = useState<string[]>([]);
  const [showInstructions, setShowInstructions] = useState(false);

  useEffect(() => {
    const s = io(serverUrl);
    setSocket(s);
    const onState = (st: VisibleState) => setState(st);
    s.on('session:state', onState);
    s.on('game:started', onState);
    s.on('game:state', onState);
    return () => {
      s.off('session:state', onState);
      s.off('game:started', onState);
      s.off('game:state', onState);
      s.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!socket) return;
    const onHand = (p: { playerId: string; hand: string[] }) => {
      if (p.playerId === myPlayerId || myPlayerId === '') {
        setHand(p.hand);
        if (!myPlayerId) setMyPlayerId(p.playerId);
      }
    };
    socket.on('player:hand', onHand);
    return () => {
      socket.off('player:hand', onHand);
    };
  }, [socket, myPlayerId]);

  useEffect(() => {
    // keep claimed rank synced to state
  }, [state?.currentRequiredRank]);

  const isHost = !!state?.players?.find((p) => p.id === myPlayerId)?.isHost;
  const currentTurnName = state?.players?.find((p) => p.id === state?.currentTurnPlayerId)?.name || '';

  return (
    <div className="app">
      <header className="header">
        <h1>Cardistry</h1>
        <div className="header-info">
          <span>Session: {state?.id || '-'}</span>
          <span>Current Rank: {state?.currentRequiredRank || '-'}</span>
          <span>Turn: {currentTurnName || '-'}</span>
        </div>
        <div className="row">
          <button onClick={() => setShowInstructions(true)}>Instructions</button>
        </div>
      </header>

      {!state && (
        <div className="panel">
          <h2>Create or Join</h2>
          <input placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} />
          <div className="row">
            <button
              onClick={() =>
                socket?.emit('session:create', { username }, (p: { sessionId: string; playerId: string }) => {
                  setSessionId(p.sessionId);
                  setMyPlayerId(p.playerId);
                })
              }
              disabled={!username}
            >
              Create Session
            </button>
            <input placeholder="Session ID" value={sessionId} onChange={(e) => setSessionId(e.target.value)} />
            <button
              onClick={() =>
                socket?.emit('session:join', { sessionId, username }, (res: { ok: boolean; playerId?: string }) => {
                  if (res.ok && res.playerId) setMyPlayerId(res.playerId);
                })
              }
              disabled={!username || !sessionId}
            >
              Join Session
            </button>
          </div>
        </div>
      )}

      {state && !state.started && (
        <div className="panel">
          <h2>Lobby</h2>
          <ul>
            {state.players.map((p) => (
              <li key={p.id}>
                {p.name} {p.isHost ? '(Host)' : ''}
                {isHost && p.id !== myPlayerId && (
                  <button className="link" onClick={() => socket?.emit('session:kick', { sessionId: state.id, playerId: p.id, by: myPlayerId })}>
                    Kick
                  </button>
                )}
              </li>
            ))}
          </ul>
          {isHost && (
            <button
              onClick={() => {
                if (state.players.length < 3) {
                  // encourage 3+
                  if (!confirm('Minimum is 2 players. We encourage 3 or more. Start anyway?')) return;
                }
                socket?.emit('game:start', { sessionId: state.id, by: myPlayerId });
              }}
              disabled={state.players.length < 2}
            >
              Start Game
            </button>
          )}
        </div>
      )}

      {state && state.started && (
        <GameView socket={socket} state={state} myPlayerId={myPlayerId} hand={hand} setHand={setHand} />
      )}

      {showInstructions && (
        <div className="modal" onClick={() => setShowInstructions(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h2>How to Play</h2>
            <p>Play cards face down claiming the current rank. Others have 5s to call BS. If correct, the liar takes the pile; otherwise, the caller does. After the next player has played, the liar can call Peanut Butter to give the pile to that next player.</p>
            <ul>
              <li>Decks: ceil(players/5), max players 10</li>
              <li>Ranks: A,2..10,J,Q,K</li>
              <li>Play up to decks*4 cards per turn</li>
            </ul>
            <button onClick={() => setShowInstructions(false)}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}

function GameView({ socket, state, myPlayerId, hand, setHand }: { socket: Socket | null; state: VisibleState; myPlayerId: string; hand: string[]; setHand: (h: string[]) => void }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [claimedRank, setClaimedRank] = useState<CardRank>(state.currentRequiredRank);
  const maxSelectable = Math.ceil(state.players.length / 5) * 4 || 4;
  const timeLeft = state.bsWindowUntil ? Math.max(0, state.bsWindowUntil - Date.now()) : 0;

  return (
    <div className="game">
      <div className="hud">
        <div>Last Play: {state.lastPlay ? `${state.lastPlay.username} played ${state.lastPlay.count} as ${state.lastPlay.claimedRank}` : '—'}</div>
        <div>Pile: {state.pileCount}</div>
        {timeLeft > 0 && <div>BS window: {(timeLeft / 1000).toFixed(1)}s</div>}
      </div>
      <div className="table">
        <PlayersRing state={state} myPlayerId={myPlayerId} />
      </div>
      <div className="controls">
        <select value={claimedRank} onChange={(e) => setClaimedRank(e.target.value as CardRank)}>
          {['A','2','3','4','5','6','7','8','9','10','J','Q','K'].map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
        <button onClick={() => socket?.emit('game:play', { sessionId: state.id, by: myPlayerId, cards: selected, claimedRank })} disabled={selected.length === 0 || selected.length > maxSelectable}>
          Confirm Play
        </button>
        <button onClick={() => socket?.emit('game:bs', { sessionId: state.id, by: myPlayerId })} disabled={!state.bsWindowUntil || Date.now() > (state.bsWindowUntil || 0)}>
          Call BS
        </button>
        <button onClick={() => socket?.emit('game:peanutButter', { sessionId: state.id, by: myPlayerId })}>
          Peanut Butter
        </button>
      </div>
      <Hand hand={hand} selected={selected} onToggle={(c) => {
        setSelected((prev) => prev.includes(c) ? prev.filter((x) => x !== c) : (prev.length < maxSelectable ? [...prev, c] : prev));
      }} />
    </div>
  );
}

function PlayersRing({ state, myPlayerId }: { state: VisibleState; myPlayerId: string }) {
  const radius = 120;
  return (
    <div className="ring">
      {state.players.map((p, idx) => {
        const angle = (2 * Math.PI * idx) / state.players.length - Math.PI / 2;
        const x = Math.cos(angle) * radius;
        const y = Math.sin(angle) * radius;
        return (
          <div key={p.id} className={`seat ${p.id === myPlayerId ? 'me' : ''}`} style={{ transform: `translate(calc(50% + ${x}px), calc(50% + ${y}px))` }}>
            <div className="avatar">{p.name.charAt(0).toUpperCase()}</div>
            <div className="label">{p.name} • {p.cardsLeft}</div>
          </div>
        );
      })}
      <div className="pile" />
    </div>
  );
}

function Hand({ hand, selected, onToggle }: { hand: string[]; selected: string[]; onToggle: (c: string) => void }) {
  return (
    <div className="hand">
      {hand.map((c) => (
        <button key={c} className={`card ${selected.includes(c) ? 'selected' : ''}`} onClick={() => onToggle(c)}>{c}</button>
      ))}
    </div>
  );
}


