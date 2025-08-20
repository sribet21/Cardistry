import { Server, Socket } from 'socket.io';
import { v4 as uuid } from 'uuid';

type CardRank = 'A' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K';
type CardSuit = 'S' | 'H' | 'D' | 'C';
export type Card = `${CardRank}${CardSuit}`;

function createDeck(numDecks: number): Card[] {
  const ranks: CardRank[] = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const suits: CardSuit[] = ['S', 'H', 'D', 'C'];
  const deck: Card[] = [];
  for (let d = 0; d < numDecks; d++) {
    for (const r of ranks) {
      for (const s of suits) {
        deck.push(`${r}${s}` as Card);
      }
    }
  }
  // shuffle
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function ceilDiv(a: number, b: number): number {
  return Math.floor((a + b - 1) / b);
}

interface PlayerState {
  id: string;
  name: string;
  socketId: string;
  hand: Card[];
  isHost: boolean;
}

interface PlayRecord {
  username: string;
  count: number;
  claimedRank: CardRank;
}

interface GameState {
  id: string;
  players: PlayerState[];
  hostId: string;
  started: boolean;
  currentTurnIndex: number;
  currentRequiredRank: CardRank;
  pileFaceDown: Card[];
  lastPlay: PlayRecord | null;
  bsWindowUntil?: number; // epoch ms
  peanutButterEligiblePlayerId?: string;
  hasNextPlayerPlayedAfterLiar?: boolean;
}

const ranksInOrder: CardRank[] = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
function nextRank(rank: CardRank): CardRank {
  const idx = ranksInOrder.indexOf(rank);
  return ranksInOrder[(idx + 1) % ranksInOrder.length];
}

const games = new Map<string, GameState>();

function dealHands(players: PlayerState[], dealerId: string): void {
  const numDecks = Math.max(1, ceilDiv(players.length, 5));
  const deck = createDeck(numDecks);
  const dealerIndex = Math.max(0, players.findIndex((p) => p.id === dealerId));
  const startIndex = (dealerIndex + 1) % players.length;
  let i = 0;
  while (deck.length > 0) {
    const recipient = players[(startIndex + i) % players.length];
    recipient.hand.push(deck.pop() as Card);
    i++;
  }
}

function getMaxSelectable(players: PlayerState[]): number {
  const numDecks = Math.max(1, ceilDiv(players.length, 5));
  return numDecks * 4;
}

function visibleState(g: GameState) {
  return {
    id: g.id,
    players: g.players.map((p) => ({ id: p.id, name: p.name, isHost: p.isHost, cardsLeft: p.hand.length })),
    started: g.started,
    currentTurnPlayerId: g.players[g.currentTurnIndex]?.id,
    currentRequiredRank: g.currentRequiredRank,
    lastPlay: g.lastPlay,
    pileCount: g.pileFaceDown.length,
    bsWindowUntil: g.bsWindowUntil ?? null,
  };
}

function pushHandsToPlayers(io: Server, g: GameState) {
  for (const p of g.players) {
    io.to(p.socketId).emit('player:hand', { playerId: p.id, hand: p.hand });
  }
}

export function createGameServer(io: Server) {
  io.on('connection', (socket: Socket) => {
    socket.on('session:create', ({ username }: { username: string }, cb: (payload: { sessionId: string; playerId: string }) => void) => {
      const id = uuid();
      const player: PlayerState = { id: uuid(), name: username, socketId: socket.id, hand: [], isHost: true };
      const game: GameState = {
        id,
        players: [player],
        hostId: player.id,
        started: false,
        currentTurnIndex: 0,
        currentRequiredRank: 'A',
        pileFaceDown: [],
        lastPlay: null,
      };
      games.set(id, game);
      socket.join(id);
      cb({ sessionId: id, playerId: player.id });
      io.to(id).emit('session:state', visibleState(game));
      pushHandsToPlayers(io, game);
    });

    socket.on('session:join', ({ sessionId, username }: { sessionId: string; username: string }, cb: (payload: { ok: boolean; playerId?: string }) => void) => {
      const g = games.get(sessionId);
      if (!g || g.started || g.players.length >= 10) {
        cb({ ok: false });
        return;
      }
      const player: PlayerState = { id: uuid(), name: username, socketId: socket.id, hand: [], isHost: false };
      g.players.push(player);
      socket.join(sessionId);
      cb({ ok: true, playerId: player.id });
      io.to(sessionId).emit('session:state', visibleState(g));
      pushHandsToPlayers(io, g);
    });

    socket.on('session:kick', ({ sessionId, playerId, by }: { sessionId: string; playerId: string; by: string }) => {
      const g = games.get(sessionId);
      if (!g || g.hostId !== by || g.started) return;
      g.players = g.players.filter((p) => p.id !== playerId);
      io.to(sessionId).emit('session:state', visibleState(g));
    });

    socket.on('game:start', ({ sessionId, by }: { sessionId: string; by: string }) => {
      const g = games.get(sessionId);
      if (!g || g.started) return;
      const canStart = g.players.length >= 2;
      if (!canStart || g.hostId !== by) return;
      g.players.forEach((p) => (p.hand = []));
      dealHands(g.players, g.hostId);
      g.started = true;
      const dealerIndex = g.players.findIndex((p) => p.id === g.hostId);
      g.currentTurnIndex = (dealerIndex + 1) % g.players.length;
      g.currentRequiredRank = 'A';
      g.pileFaceDown = [];
      g.lastPlay = null;
      g.bsWindowUntil = undefined;
      g.peanutButterEligiblePlayerId = undefined;
      g.hasNextPlayerPlayedAfterLiar = false;
      io.to(sessionId).emit('game:started', visibleState(g));
      pushHandsToPlayers(io, g);
    });

    socket.on('game:play', ({ sessionId, by, cards, claimedRank }: { sessionId: string; by: string; cards: Card[]; claimedRank: CardRank }) => {
      const g = games.get(sessionId);
      if (!g || !g.started) return;
      const current = g.players[g.currentTurnIndex];
      if (!current || current.id !== by) return;

      const player = g.players.find((p) => p.id === by);
      if (!player) return;
      const maxSelectable = getMaxSelectable(g.players);
      if (cards.length < 1 || cards.length > maxSelectable) return;
      // verify player owns the cards
      for (const c of cards) {
        const idx = player.hand.indexOf(c);
        if (idx === -1) return;
      }
      // remove from hand and add to pile face down
      for (const c of cards) {
        const idx = player.hand.indexOf(c);
        player.hand.splice(idx, 1);
        g.pileFaceDown.push(c);
      }

      g.lastPlay = { username: player.name, count: cards.length, claimedRank };
      g.bsWindowUntil = Date.now() + 5000; // 5 seconds to call BS
      if (g.peanutButterEligiblePlayerId && g.peanutButterEligiblePlayerId !== player.id) {
        g.hasNextPlayerPlayedAfterLiar = true;
      } else {
        g.hasNextPlayerPlayedAfterLiar = false;
      }
      g.peanutButterEligiblePlayerId = player.id;

      // move turn forward and update required rank to next
      g.currentTurnIndex = (g.currentTurnIndex + 1) % g.players.length;
      g.currentRequiredRank = nextRank(g.currentRequiredRank);

      io.to(sessionId).emit('game:state', visibleState(g));
      pushHandsToPlayers(io, g);
    });

    socket.on('game:bs', ({ sessionId, by }: { sessionId: string; by: string }) => {
      const g = games.get(sessionId);
      if (!g || !g.started || !g.lastPlay) return;
      if (!g.bsWindowUntil || Date.now() > g.bsWindowUntil) return; // outside window

      const lastPlayer = g.players.find((p) => p.name === g.lastPlay?.username);
      if (!lastPlayer) return;

      const claimedRank = g.lastPlay.claimedRank;
      const countClaimed = g.lastPlay.count;
      const lastPlayedCards = g.pileFaceDown.slice(-countClaimed);
      const liar = lastPlayedCards.some((c) => !c.startsWith(claimedRank));

      const caller = g.players.find((p) => p.id === by);
      if (!caller) return;

      const loser = liar ? lastPlayer : caller; // loser takes the pile
      loser.hand.push(...g.pileFaceDown);
      g.pileFaceDown = [];
      g.bsWindowUntil = undefined;
      g.lastPlay = null;
      g.peanutButterEligiblePlayerId = undefined;
      g.hasNextPlayerPlayedAfterLiar = false;

      io.to(sessionId).emit('game:state', visibleState(g));
      pushHandsToPlayers(io, g);
    });

    socket.on('game:peanutButter', ({ sessionId, by }: { sessionId: string; by: string }) => {
      const g = games.get(sessionId);
      if (!g || !g.started || !g.peanutButterEligiblePlayerId) return;

      // only eligible after next player has played
      if (!g.hasNextPlayerPlayedAfterLiar) return;
      if (g.peanutButterEligiblePlayerId !== by) return;
      if (!g.lastPlay) return;

      const lastPlayer = g.players.find((p) => p.name === g.lastPlay?.username);
      if (!lastPlayer) return;

      // peanut butter: last player (the next player who played) takes the pile
      lastPlayer.hand.push(...g.pileFaceDown);
      g.pileFaceDown = [];
      g.lastPlay = null;
      g.peanutButterEligiblePlayerId = undefined;
      g.hasNextPlayerPlayedAfterLiar = false;

      io.to(sessionId).emit('game:state', visibleState(g));
      pushHandsToPlayers(io, g);
    });

    socket.on('disconnect', () => {
      // Clean up: remove player from any games
      for (const g of games.values()) {
        const idx = g.players.findIndex((p) => p.socketId === socket.id);
        if (idx !== -1) {
          const wasHost = g.players[idx].id === g.hostId;
          g.players.splice(idx, 1);
          if (wasHost && g.players[0]) {
            g.hostId = g.players[0].id;
            g.players[0].isHost = true;
          }
          io.to(g.id).emit('session:state', visibleState(g));
        }
      }
    });
  });
}


