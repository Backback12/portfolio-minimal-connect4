/* -------------------------------------------------------------------------- */
/*                         CONNECT FOUR OWNER PANEL                           */
/* -------------------------------------------------------------------------- */

const config = window.OWNER_CONFIG || {};

const SUPABASE_URL = String(config.supabaseUrl || '').replace(/\/$/, '');
const SUPABASE_PUBLISHABLE_KEY = String(
  config.publishableKey || ''
);
const OWNER_PASSWORD_HASH = String(
  config.passwordHash || ''
).toLowerCase();

const GAME_STATE_ID = 1;
const POLL_INTERVAL_MS = 5000;
const GRID_COLUMNS = 7;
const GRID_ROWS = 6;

// Server semantics.
const PUBLIC_TURN_VALUE = 1;
const OWNER_TURN_VALUE = 2;

// Server board format:
// row 0 is always the TOP row.
const SERVER_ROW_ZERO_IS_TOP = true;

const GAME_STATE_URL = SUPABASE_URL
  ? `${SUPABASE_URL}/rest/v1/game_state?id=eq.${GAME_STATE_ID}&select=*`
  : null;

const EDGE_FUNCTION_URL = SUPABASE_URL
  ? `${SUPABASE_URL}/functions/v1/connect4`
  : null;

const loginPanel =
  document.getElementById('login-panel');

const gamePanel =
  document.getElementById('game-panel');

const passwordInput =
  document.getElementById('password');

const unlockButton =
  document.getElementById('unlock');

const loginMessage =
  document.getElementById('login-message');

const statusElement =
  document.getElementById('status');

const boardElement =
  document.getElementById('board');

const publicScoreElement =
  document.getElementById('public-score');

const ownerScoreElement =
  document.getElementById('owner-score');

const ownerControls =
  document.getElementById('owner-controls');

const columnInput =
  document.getElementById('column');

const moveButton =
  document.getElementById('move');

const messageElement =
  document.getElementById('message');

/* -------------------------------------------------------------------------- */
/*                              OWNER PHRASE UI                               */
/* -------------------------------------------------------------------------- */

const ownerPhraseRow = document.createElement('div');

ownerPhraseRow.className = 'row';

ownerPhraseRow.innerHTML = `
  <label for="owner-phrase">phrase:</label>
  <input
    id="owner-phrase"
    type="password"
    autocomplete="off"
  >
`;

loginPanel.insertBefore(
  ownerPhraseRow,
  loginMessage
);

const ownerPhraseInput =
  document.getElementById('owner-phrase');

/* -------------------------------------------------------------------------- */
/*                                  STATE                                     */
/* -------------------------------------------------------------------------- */

let pollTimer = null;
let pollInFlight = false;
let moveInFlight = false;
let unlocked = false;

// Held only in memory while this page is open.
let ownerToken = '';

let currentTurn = null;
let board = createEmptyBoard();

let publicScore = 0;
let ownerScore = 0;

let lastBoardSignature = '';

/* -------------------------------------------------------------------------- */
/*                                UTILITIES                                   */
/* -------------------------------------------------------------------------- */

function createEmptyBoard() {
  return Array.from(
    { length: GRID_ROWS },
    () => Array(GRID_COLUMNS).fill(0)
  );
}

function setLoginMessage(text = '') {
  loginMessage.textContent = text;
}

function setMessage(text = '') {
  messageElement.textContent = text;
}

async function sha256Hex(value) {
  const bytes =
    new TextEncoder().encode(value);

  const digest =
    await crypto.subtle.digest(
      'SHA-256',
      bytes
    );

  return [...new Uint8Array(digest)]
    .map((byte) =>
      byte.toString(16).padStart(2, '0')
    )
    .join('');
}

/* -------------------------------------------------------------------------- */
/*                                  LOGIN                                     */
/* -------------------------------------------------------------------------- */

async function unlock() {
  setLoginMessage('');

  if (
    !OWNER_PASSWORD_HASH ||
    OWNER_PASSWORD_HASH.includes('__OWNER_')
  ) {
    setLoginMessage(
      'Password hash is not configured.'
    );
    return;
  }

  const password =
    passwordInput.value;

  const phrase =
    ownerPhraseInput.value.trim();

  if (!password) {
    setLoginMessage(
      'Enter a password.'
    );
    return;
  }

  if (!phrase) {
    setLoginMessage(
      'Enter the owner phrase.'
    );
    return;
  }

  unlockButton.disabled = true;

  try {
    const enteredHash =
      await sha256Hex(password);

    if (
      enteredHash !== OWNER_PASSWORD_HASH
    ) {
      setLoginMessage(
        'Invalid password.'
      );

      passwordInput.select();
      return;
    }

    /*
     * The phrase is NOT stored in the frontend configuration.
     * It exists only in memory and is sent to the Edge Function
     * as X-Owner-Token when an owner move is submitted.
     */
    ownerToken = phrase;

    unlocked = true;

    loginPanel.hidden = true;
    gamePanel.hidden = false;

    passwordInput.value = '';
    ownerPhraseInput.value = '';

    await fetchGameState(true);
    startPolling();
  } catch (error) {
    console.error(
      'Unlock failed:',
      error
    );

    setLoginMessage(
      'Unable to unlock.'
    );
  } finally {
    unlockButton.disabled = false;
  }
}

/* -------------------------------------------------------------------------- */
/*                              BOARD HANDLING                                */
/* -------------------------------------------------------------------------- */

function normalizeCell(value) {
  if (
    value === 1 ||
    value === '1'
  ) {
    return 1;
  }

  if (
    value === 2 ||
    value === '2'
  ) {
    return 2;
  }

  return 0;
}

function normalizeBoard(serverBoard) {
  if (
    !Array.isArray(serverBoard) ||
    serverBoard.length !== GRID_ROWS
  ) {
    throw new Error(
      'Invalid board dimensions.'
    );
  }

  const nextBoard =
    createEmptyBoard();

  for (
    let serverRow = 0;
    serverRow < GRID_ROWS;
    serverRow++
  ) {
    const row =
      serverBoard[serverRow];

    if (
      !Array.isArray(row) ||
      row.length !== GRID_COLUMNS
    ) {
      throw new Error(
        `Invalid board row ${serverRow}.`
      );
    }

    const displayRow =
      SERVER_ROW_ZERO_IS_TOP
        ? serverRow
        : GRID_ROWS - 1 - serverRow;

    for (
      let column = 0;
      column < GRID_COLUMNS;
      column++
    ) {
      nextBoard[displayRow][column] =
        normalizeCell(row[column]);
    }
  }

  return nextBoard;
}

function boardToText() {
  return " 0  1  2  3  4  5  6 \n" +
  board
    .map((row) =>
      row
        .map((cell) => {
          if (cell === 1) {
            return '[X]';
          }

          if (cell === 2) {
            return '[O]';
          }

          return '[ ]';
        })
        .join('')
    )
    .join('\n');
}

function isBoardFull() {
  return board.every(
    (row) =>
      row.every(
        (cell) => cell !== 0
      )
  );
}

function hasWinner(player) {
  const directions = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1]
  ];

  for (
    let row = 0;
    row < GRID_ROWS;
    row++
  ) {
    for (
      let column = 0;
      column < GRID_COLUMNS;
      column++
    ) {
      if (
        board[row][column] !== player
      ) {
        continue;
      }

      for (const [dx, dy] of directions) {
        let count = 1;

        let x = column + dx;
        let y = row + dy;

        while (
          x >= 0 &&
          x < GRID_COLUMNS &&
          y >= 0 &&
          y < GRID_ROWS &&
          board[y][x] === player
        ) {
          count++;
          x += dx;
          y += dy;
        }

        if (count >= 4) {
          return true;
        }
      }
    }
  }

  return false;
}

function getWinner() {
  if (hasWinner(1)) {
    return 1;
  }

  if (hasWinner(2)) {
    return 2;
  }

  return 0;
}

/* -------------------------------------------------------------------------- */
/*                                  RENDER                                    */
/* -------------------------------------------------------------------------- */

function render() {
  boardElement.textContent =
    boardToText();

  publicScoreElement.textContent =
    String(publicScore);

  ownerScoreElement.textContent =
    String(ownerScore);

  const winner =
    getWinner();

  if (winner === 1) {
    statusElement.textContent =
      'PUBLIC WINS';

    ownerControls.hidden = true;
    return;
  }

  if (winner === 2) {
    statusElement.textContent =
      'OWNER WINS';

    ownerControls.hidden = true;
    return;
  }

  if (isBoardFull()) {
    statusElement.textContent =
      'DRAW';

    ownerControls.hidden = true;
    return;
  }

  if (
    currentTurn === OWNER_TURN_VALUE
  ) {
    statusElement.textContent =
      "OWNER'S TURN";

    ownerControls.hidden = false;
    return;
  }

  if (
    currentTurn === PUBLIC_TURN_VALUE
  ) {
    statusElement.textContent =
      "PUBLIC'S TURN";

    ownerControls.hidden = true;
    return;
  }

  statusElement.textContent =
    'WAITING FOR SERVER';

  ownerControls.hidden = true;
}

/* -------------------------------------------------------------------------- */
/*                              DATABASE POLLING                              */
/* -------------------------------------------------------------------------- */

async function fetchGameState(force = false) {
  if (
    !unlocked ||
    !GAME_STATE_URL
  ) {
    return;
  }

  if (
    pollInFlight &&
    !force
  ) {
    return;
  }

  pollInFlight = true;

  try {
    const response =
      await fetch(
        GAME_STATE_URL,
        {
          method: 'GET',
          headers: {
            apikey:
              SUPABASE_PUBLISHABLE_KEY,
            Accept:
              'application/json',
            'Cache-Control':
              'no-cache'
          },
          cache: 'no-store'
        }
      );

    if (!response.ok) {
      throw new Error(
        `State request failed (${response.status}).`
      );
    }

    const data =
      await response.json();

    if (
      !Array.isArray(data) ||
      data.length === 0
    ) {
      throw new Error(
        'No game state returned.'
      );
    }

    const state =
      data[0];

    board =
      normalizeBoard(
        state.board
      );

    currentTurn =
      Number(
        state.current_turn
      );

    publicScore =
      Number(
        state.public_score
      ) || 0;

    ownerScore =
      Number(
        state.owner_score
      ) || 0;

    const signature =
      JSON.stringify({
        board,
        currentTurn,
        publicScore,
        ownerScore
      });

    if (
      signature !==
      lastBoardSignature
    ) {
      lastBoardSignature =
        signature;

      setMessage('');
    }

    render();
  } catch (error) {
    console.error(
      'Failed to fetch game state:',
      error
    );

    statusElement.textContent =
      'SERVER ERROR';

    setMessage(
      error.message ||
      'Unable to retrieve game state.'
    );

    ownerControls.hidden =
      true;
  } finally {
    pollInFlight = false;
  }
}

/* -------------------------------------------------------------------------- */
/*                              OWNER MOVE                                    */
/* -------------------------------------------------------------------------- */

async function submitOwnerMove() {
  if (
    !unlocked ||
    moveInFlight
  ) {
    return;
  }

  if (
    currentTurn !==
    OWNER_TURN_VALUE
  ) {
    setMessage(
      "It is not the owner's turn."
    );
    return;
  }

  if (!ownerToken) {
    setMessage(
      'Owner phrase is missing.'
    );
    return;
  }

  const column =
    Number(
      columnInput.value
    );

  if (
    !Number.isInteger(column) ||
    column < 0 ||
    column >= GRID_COLUMNS
  ) {
    setMessage(
      'Column must be an integer from 0 to 6.'
    );

    columnInput.focus();
    return;
  }

  const columnFull =
    board.every(
      (row) =>
        row[column] !== 0
    );

  if (columnFull) {
    setMessage(
      'That column is full.'
    );
    return;
  }

  moveInFlight = true;

  moveButton.disabled = true;
  columnInput.disabled = true;

  setMessage(
    'Submitting move...'
  );

  try {
    const response =
      await fetch(
        `${EDGE_FUNCTION_URL}?slot=${column}`,
        {
          method: 'POST',

          headers: {
            'Content-Type':
              'application/json',

            apikey:
              SUPABASE_PUBLISHABLE_KEY,

            /*
             * This is the manually entered owner phrase.
             * The actual expected value exists only in the
             * Supabase Edge Function secret.
             */
            'X-Owner-Token':
              ownerToken
          },

          body: JSON.stringify({
            source:
              'owner-panel'
          })
        }
      );

    const contentType =
      response.headers.get(
        'content-type'
      ) || '';

    let result = null;
    let text = '';

    if (
      contentType.includes(
        'application/json'
      )
    ) {
      result =
        await response.json();
    } else {
      text =
        await response.text();
    }

    if (!response.ok) {
      throw new Error(
        result?.error ||
        text ||
        `Move request failed (${response.status}).`
      );
    }

    if (result?.error) {
      throw new Error(
        result.error
      );
    }

    columnInput.value = '';

    setMessage(
      'Move accepted.'
    );

    await fetchGameState(true);
  } catch (error) {
    console.error(
      'Owner move failed:',
      error
    );

    setMessage(
      error.message ||
      'Move failed.'
    );

    await fetchGameState(true);
  } finally {
    moveInFlight = false;

    moveButton.disabled = false;
    columnInput.disabled = false;

    if (
      currentTurn ===
      OWNER_TURN_VALUE
    ) {
      columnInput.focus();
    }

    render();
  }
}

/* -------------------------------------------------------------------------- */
/*                                POLLING                                     */
/* -------------------------------------------------------------------------- */

function startPolling() {
  if (pollTimer) {
    return;
  }

  pollTimer =
    window.setInterval(
      () => {
        fetchGameState(false);
      },
      POLL_INTERVAL_MS
    );
}

function stopPolling() {
  if (!pollTimer) {
    return;
  }

  window.clearInterval(
    pollTimer
  );

  pollTimer = null;
}

/* -------------------------------------------------------------------------- */
/*                                EVENTS                                      */
/* -------------------------------------------------------------------------- */

unlockButton.addEventListener(
  'click',
  unlock
);

passwordInput.addEventListener(
  'keydown',
  (event) => {
    if (event.key === 'Enter') {
      unlock();
    }
  }
);

ownerPhraseInput.addEventListener(
  'keydown',
  (event) => {
    if (event.key === 'Enter') {
      unlock();
    }
  }
);

moveButton.addEventListener(
  'click',
  submitOwnerMove
);

columnInput.addEventListener(
  'keydown',
  (event) => {
    if (event.key === 'Enter') {
      submitOwnerMove();
    }
  }
);

window.addEventListener(
  'pagehide',
  () => {
    stopPolling();

    // Explicitly discard the owner token.
    ownerToken = '';
    unlocked = false;
  },
  { once: true }
);