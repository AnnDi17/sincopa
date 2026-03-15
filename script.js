// ——— VK: дождаться Bridge, вызвать VKWebAppInit, только потом разрешить игру ———
(function () {
    var loadingEl = document.getElementById('vk-loading');
    var vkInitDone = false;
    var VK_INIT_TIMEOUT_MS = 25000;  /* лимит VK 30 сек, даём запас */
    var FALLBACK_MS = 8000;          /* вне VK: не блокировать игру дольше 8 сек */

    function doVKInit() {
        if (typeof vkBridge !== 'undefined') {
            vkBridge.send('VKWebAppInit', {});
            document.body.classList.add('vk-embed');
            return true;
        }
        return false;
    }

    function onVKReady() {
        if (vkInitDone) return;
        vkInitDone = true;
        if (loadingEl) {
            loadingEl.classList.add('hidden');
            setTimeout(function () { loadingEl.style.display = 'none'; }, 300);
        }
    }

    function tryInitAndReady() {
        if (doVKInit()) onVKReady();
    }

    tryInitAndReady();

    var bridgeScript = document.querySelector('script[src*="vk-bridge"]');
    if (bridgeScript) {
        bridgeScript.addEventListener('load', tryInitAndReady);
        if (bridgeScript.readyState === 'complete' || bridgeScript.readyState === 'loaded') tryInitAndReady();
    }

    var deadline = Date.now() + VK_INIT_TIMEOUT_MS;
    var poll = setInterval(function () {
        if (vkInitDone || Date.now() > deadline) {
            clearInterval(poll);
            if (!vkInitDone) onVKReady();
            return;
        }
        tryInitAndReady();
    }, 400);

    window.addEventListener('load', function () {
        tryInitAndReady();
        setTimeout(function () {
            if (!vkInitDone) onVKReady();
        }, FALLBACK_MS);
    });
})();

// ——— Прод: ориентация по размеру окна (без переключателей) ———
(function () {
    function applyOrientation() {
        if (window.innerWidth > window.innerHeight) {
            document.body.classList.add('force-landscape');
            document.body.classList.remove('force-portrait');
        } else {
            document.body.classList.remove('force-landscape');
            document.body.classList.add('force-portrait');
        }
    }
    applyOrientation();
    window.addEventListener('resize', function () {
        applyOrientation();
        if (typeof render === 'function' && screens.game.classList.contains('active')) render();
    });
})();

const GRID_SIZE = 15;
const BASE_TICK_RATE = 350;
const MIN_TICK_RATE = 140;
const BASIC_FOODS_FOR_LEVEL = 10;
const COMBO_TICKS_LIMIT = 15;
const GOLDEN_FOOD_LIFETIME = 25;
const PATROL_EVERY_N_TICKS = 2;

let snake = [];
let direction = { x: 0, y: 0 };
let directionQueue = [];
let basicFood = { x: 0, y: 0 };
let goldenFood = null;
let score = 0;
let currentLevel = 1;
let lives = 3;
let comboCount = 1;
let ticksSinceLastFood = 0;
let goldenFoodTicks = 0;
let basicFoodsEatenThisLevel = 0;
let currentTickRate = BASE_TICK_RATE;

let isPaused = false;
let isTransitioning = false;
let awaitingFirstInput = true;
let gameInterval = null;
let activeTeleport = null;

let highScore = localStorage.getItem('snakeHighScore') || 0;
let maxLevelReached = localStorage.getItem('snakeMaxLevel') || 1;

let walls = [];
let portals = [];
let patrols = []; // {x, y, dx, dy, minX, maxX, minY, maxY}
let patrolTickCounter = 0;

let isManualSwitch = false;
let shuffledTemplateOrder = [];

function shuffleTemplates() {
    shuffledTemplateOrder = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    for (let i = shuffledTemplateOrder.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffledTemplateOrder[i], shuffledTemplateOrder[j]] = [shuffledTemplateOrder[j], shuffledTemplateOrder[i]];
    }
}

// DOM
const screens = {
    menu: document.getElementById('menu-screen'),
    game: document.getElementById('game-screen'),
    gameOver: document.getElementById('game-over-screen')
};

const boardEl = document.getElementById('game-board');
const scoreDisplay = document.querySelector('.score-display');
const levelDisplay = document.querySelector('.level-display');
const comboIndicator = document.getElementById('combo-indicator');
const levelToast = document.getElementById('level-toast');
const lifeMarkers = document.querySelectorAll('.life-marker');
const finalScoreEl = document.getElementById('final-score');
const finalLevelEl = document.getElementById('final-level');
const highScoreEl = document.getElementById('high-score');
const maxLevelEl = document.getElementById('max-level');
const newRecordBadge = document.getElementById('new-record-badge');
const newLevelBadge = document.getElementById('new-level-badge');
const pauseOverlay = document.getElementById('pause-overlay');

function init() {
    document.getElementById('btn-start').addEventListener('click', startGame);
    document.getElementById('btn-restart').addEventListener('click', startGame);
    document.getElementById('btn-menu-from-over').addEventListener('click', showMenu);
    document.getElementById('btn-menu-from-pause').addEventListener('click', showMenu);
    
    document.getElementById('btn-pause').addEventListener('click', togglePause);
    document.getElementById('btn-resume').addEventListener('click', togglePause);

    // Управление
    document.getElementById('btn-up').addEventListener('touchstart', (e) => { e.preventDefault(); queueDirection(0, -1); });
    document.getElementById('btn-down').addEventListener('touchstart', (e) => { e.preventDefault(); queueDirection(0, 1); });
    document.getElementById('btn-left').addEventListener('touchstart', (e) => { e.preventDefault(); queueDirection(-1, 0); });
    document.getElementById('btn-right').addEventListener('touchstart', (e) => { e.preventDefault(); queueDirection(1, 0); });
    
    document.getElementById('btn-up').addEventListener('mousedown', () => queueDirection(0, -1));
    document.getElementById('btn-down').addEventListener('mousedown', () => queueDirection(0, 1));
    document.getElementById('btn-left').addEventListener('mousedown', () => queueDirection(-1, 0));
    document.getElementById('btn-right').addEventListener('mousedown', () => queueDirection(1, 0));

    document.addEventListener('keydown', handleKeyPress);
    setupSwipeControls();
}

function showScreen(screenName) {
    Object.values(screens).forEach(s => s.classList.remove('active'));
    screens[screenName].classList.add('active');
}

function startGame() {
    score = 0;
    currentLevel = 1;
    lives = 3;
    shuffleTemplates();
    updateLivesDisplay();
    maxLevelReached = localStorage.getItem('snakeMaxLevel') || 1;
    showScreen('game');
    // Даём браузеру сделать раскладку экрана игры, затем инициализируем и рисуем змею
    requestAnimationFrame(function () {
        resetSession();
    });
}

function resetSession() {
    snake = [
        { x: 3, y: 7 },
        { x: 2, y: 7 },
        { x: 1, y: 7 },
        { x: 0, y: 7 }
    ];
    direction = { x: 1, y: 0 };
    directionQueue = [];
    comboCount = 1;
    ticksSinceLastFood = 0;
    goldenFoodTicks = 0;
    basicFoodsEatenThisLevel = 0;
    goldenFood = null;
    isPaused = false;
    isTransitioning = false;
    patrolTickCounter = 0;
    
    updateScoreDisplay();
    updateLevelDisplay();
    hideCombo();
    pauseOverlay.classList.add('hidden');
    levelToast.classList.add('hidden');
    
    setupLevelMap();
    setupSafeStart();
    placeBasicFood();
    
    currentTickRate = Math.max(MIN_TICK_RATE, BASE_TICK_RATE - (currentLevel - 1) * 26);
    
    awaitingFirstInput = true;
    
    if (gameInterval) clearInterval(gameInterval);
    gameInterval = setInterval(gameLoop, currentTickRate);
    render();
}

function showMenu() {
    if (gameInterval) clearInterval(gameInterval);
    showScreen('menu');
}

function gameOver() {
    if (gameInterval) clearInterval(gameInterval);
    
    // Haptic feedback simulation
    if (navigator.vibrate) navigator.vibrate(200);
    
    finalScoreEl.textContent = formatScore(score);
    finalLevelEl.textContent = currentLevel;
    
    let isNewRecord = false;
    if (score > highScore) {
        highScore = score;
        localStorage.setItem('snakeHighScore', highScore);
        isNewRecord = true;
    }
    
    let isNewLevelRecord = false;
    if (currentLevel > maxLevelReached) {
        maxLevelReached = currentLevel;
        localStorage.setItem('snakeMaxLevel', maxLevelReached);
        isNewLevelRecord = true;
    }
    
    highScoreEl.textContent = formatScore(highScore);
    maxLevelEl.textContent = maxLevelReached;
    
    if (isNewRecord && score > 0) newRecordBadge.classList.remove('hidden');
    else newRecordBadge.classList.add('hidden');
    
    if (isNewLevelRecord && currentLevel > 1) newLevelBadge.classList.remove('hidden');
    else newLevelBadge.classList.add('hidden');
    
    setTimeout(() => { showScreen('gameOver'); }, 500);
}

function togglePause() {
    if (isTransitioning) return;
    isPaused = !isPaused;
    if (isPaused) {
        pauseOverlay.classList.remove('hidden');
        clearInterval(gameInterval);
    } else {
        pauseOverlay.classList.add('hidden');
        awaitingFirstInput = true;
        gameInterval = setInterval(gameLoop, currentTickRate);
    }
}

function handleCollision() {
    if (lives > 1) {
        lives--;
        updateLivesDisplay(true);
        
        isTransitioning = true;
        flashGlitch();
        
        if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
        
        setTimeout(() => {
            snake = [
                { x: 3, y: 7 },
                { x: 2, y: 7 },
                { x: 1, y: 7 },
                { x: 0, y: 7 }
            ];
            direction = { x: 1, y: 0 };
            setupSafeStart();
            directionQueue = [];
            comboCount = 1;
            ticksSinceLastFood = 0;
            hideCombo();
            
            placeBasicFood();
            goldenFood = null; 
            
            awaitingFirstInput = true;
            isTransitioning = false;
            render();
        }, 1000);
    } else {
        lives--;
        updateLivesDisplay(true);
        gameOver();
    }
}

function updateLivesDisplay(animateLoss = false) {
    lifeMarkers.forEach((marker, index) => {
        if (index < lives) {
            marker.classList.add('active');
            marker.classList.remove('lost');
        } else {
            if (marker.classList.contains('active')) {
                marker.classList.remove('active');
                if (animateLoss) marker.classList.add('lost');
            }
        }
    });
}

function flashGlitch() {
    const overlay = document.getElementById('flash-overlay');
    if (!overlay) return;
    overlay.classList.add('glitch');
    setTimeout(() => {
        overlay.classList.remove('glitch');
    }, 400);
}

function gameLoop() {
    if (isPaused || isTransitioning || awaitingFirstInput) return;

    if (directionQueue.length > 0) {
        direction = directionQueue.shift();
    }

    let head = { x: snake[0].x + direction.x, y: snake[0].y + direction.y };

    // Portals teleportation
    let teleported = false;
    for (let p of portals) {
        if (head.x === p.outX && head.y === p.outY) {
            head.x = p.inX;
            head.y = p.inY;
            teleported = true;
            
            activeTeleport = p;
            setTimeout(() => { activeTeleport = null; if(!isPaused) render(); }, 300);
            
            break;
        }
    }

    // Border collision
    if (!teleported && (head.x < 0 || head.x >= GRID_SIZE || head.y < 0 || head.y >= GRID_SIZE)) {
        return handleCollision();
    }

    // Walls collision
    if (walls.some(w => w.x === head.x && w.y === head.y)) {
        return handleCollision();
    }

    // Self collision
    if (snake.some(segment => segment.x === head.x && segment.y === head.y)) {
        return handleCollision();
    }

    // Patrols movement (раз в PATROL_EVERY_N_TICKS тиков — замедленно)
    patrolTickCounter++;
    if (patrolTickCounter % PATROL_EVERY_N_TICKS === 0) {
        for (let p of patrols) {
            p.x += p.dx;
            p.y += p.dy;
            if (p.x < p.minX || p.x > p.maxX || p.y < p.minY || p.y > p.maxY) {
                p.dx *= -1;
                p.dy *= -1;
                p.x += p.dx * 2;
                p.y += p.dy * 2;
            }
        }
    }

    // Patrols collision
    if (patrols.some(p => p.x === head.x && p.y === head.y)) {
        return handleCollision();
    }
    // Cross collision with patrol
    if (patrols.some(p => p.x === snake[0].x && p.y === snake[0].y && p.x - p.dx === head.x && p.y - p.dy === head.y)) {
        return handleCollision();
    }

    snake.unshift(head);
    let ateFood = false;

    // Golden food
    if (goldenFood) {
        goldenFoodTicks++;
        if (head.x === goldenFood.x && head.y === goldenFood.y) {
            let pts = 5 * comboCount;
            score += pts;
            showFloatingText(`+${pts}`, goldenFood.x, goldenFood.y, 'gold-text');
            goldenFood = null;
            ateFood = true;
            if (navigator.vibrate) navigator.vibrate(50);
        } else if (goldenFoodTicks >= GOLDEN_FOOD_LIFETIME) {
            goldenFood = null; // disappears
        }
    }

    // Basic food
    if (head.x === basicFood.x && head.y === basicFood.y) {
        score += 1 * comboCount;
        comboCount++;
        ticksSinceLastFood = 0;
        basicFoodsEatenThisLevel++;
        ateFood = true;
        if (navigator.vibrate) navigator.vibrate(50);
        
        showCombo();
        updateScoreDisplay();

        if (basicFoodsEatenThisLevel >= BASIC_FOODS_FOR_LEVEL) {
            return handleLevelTransition();
        } else {
            placeBasicFood();
            if (basicFoodsEatenThisLevel % 5 === 0) {
                placeGoldenFood();
            }
        }
    }

    if (!ateFood) {
        snake.pop();
        ticksSinceLastFood++;
        if (ticksSinceLastFood > COMBO_TICKS_LIMIT) {
            comboCount = 1;
            hideCombo();
        }
    }

    updateScoreDisplay();
    render();
}

function handleLevelTransition() {
    isTransitioning = true;
    currentLevel++;
    
    if (lives < 3) {
        lives++;
        updateLivesDisplay();
    }
    
    levelToast.textContent = `УРОВЕНЬ ${currentLevel}`;
    levelToast.classList.remove('hidden');
    render(); // show final frame before pause
    
    setTimeout(() => {
        levelToast.classList.add('hidden');
        resetSession();
    }, 1000);
}

function queueDirection(dx, dy) {
    if (awaitingFirstInput) {
        if (direction.x !== 0 && dx === -direction.x) return;
        if (direction.y !== 0 && dy === -direction.y) return;
        
        direction = { x: dx, y: dy };
        awaitingFirstInput = false;
        if (navigator.vibrate) navigator.vibrate(10);
        return;
    }

    if (directionQueue.length < 2) {
        const lastDir = directionQueue.length > 0 ? directionQueue[directionQueue.length - 1] : direction;
        if (lastDir.x !== 0 && dx !== 0) return;
        if (lastDir.y !== 0 && dy !== 0) return;
        directionQueue.push({ x: dx, y: dy });
        if (navigator.vibrate) navigator.vibrate(10); // Haptic tick
    }
}

function setupLevelMap() {
    walls = [];
    portals = [];
    patrols = [];
    
    if (currentLevel === 3) {
        for(let x=6; x<=8; x++) for(let y=6; y<=8; y++) walls.push({x,y});
    } else if (currentLevel === 4) {
        let corners = [[2,2],[2,3],[3,2], [12,2],[12,3],[11,2], [2,12],[2,11],[3,12], [12,12],[12,11],[11,12]];
        corners.forEach(p => walls.push({x:p[0], y:p[1]}));
    } else if (currentLevel === 5) {
        for(let x=3; x<=11; x++) { walls.push({x, y:4}); walls.push({x, y:10}); }
        portals.push({outX: -1, outY: 7, inX: 14, inY: 7, type: 'left'});
        portals.push({outX: 15, outY: 7, inX: 0, inY: 7, type: 'right'});
    } else if (currentLevel === 6) {
        portals.push({outX: 7, outY: -1, inX: 7, inY: 14, type: 'top'});
        portals.push({outX: 7, outY: 15, inX: 7, inY: 0, type: 'bottom'});
        portals.push({outX: -1, outY: 7, inX: 14, inY: 7, type: 'left'});
        portals.push({outX: 15, outY: 7, inX: 0, inY: 7, type: 'right'});
    } else if (currentLevel === 7) {
        patrols.push({x: 2, y: 2, dx: 1, dy: 0, minX: 2, maxX: 12, minY: 2, maxY: 2});
        patrols.push({x: 12, y: 12, dx: -1, dy: 0, minX: 2, maxX: 12, minY: 12, maxY: 12});
    } else if (currentLevel === 8) {
        for(let y=2; y<=12; y++) { if(y!==7) { walls.push({x: 4, y}); walls.push({x: 10, y}); } }
        portals.push({outX: -1, outY: 7, inX: 14, inY: 7, type: 'left'});
        portals.push({outX: 15, outY: 7, inX: 0, inY: 7, type: 'right'});
        patrols.push({x: 7, y: 2, dx: 0, dy: 1, minX: 7, maxX: 7, minY: 2, maxY: 12});
    } else if (currentLevel >= 9) {
        let idx = (currentLevel - 9) % 12;
        if (idx === 0 && currentLevel > 9 && !isManualSwitch) {
            shuffleTemplates();
        }
        if (shuffledTemplateOrder.length === 0) shuffleTemplates();
        let templateId = shuffledTemplateOrder[idx];
        setupTemplate(templateId);
    }
}

function setupTemplate(templateId) {
    switch (templateId) {
        case 0: // A («Шестерня»)
            for (let y = 2; y <= 12; y++) {
                if (y !== 4 && y !== 10) { walls.push({x: 4, y}); walls.push({x: 10, y}); }
            }
            for (let x = 2; x <= 12; x++) {
                if (x !== 4 && x !== 5 && x !== 9 && x !== 10) { walls.push({x, y: 4}); walls.push({x, y: 10}); }
            }
            portals.push({outX: 7, outY: -1, inX: 7, inY: 14, type: 'top'});
            portals.push({outX: 7, outY: 15, inX: 7, inY: 0, type: 'bottom'});
            portals.push({outX: -1, outY: 7, inX: 14, inY: 7, type: 'left'});
            portals.push({outX: 15, outY: 7, inX: 0, inY: 7, type: 'right'});
            patrols.push({x: 5, y: 5, dx: 0, dy: 1, minX: 5, maxX: 5, minY: 5, maxY: 9});
            patrols.push({x: 9, y: 9, dx: 0, dy: -1, minX: 9, maxX: 9, minY: 5, maxY: 9});
            patrols.push({x: 5, y: 9, dx: 1, dy: 0, minX: 5, maxX: 9, minY: 9, maxY: 9});
            patrols.push({x: 9, y: 5, dx: -1, dy: 0, minX: 5, maxX: 9, minY: 5, maxY: 5});
            break;

        case 1: // B («Каналы»)
            for (let y = 0; y <= 10; y++) { walls.push({x: 3, y}); walls.push({x: 11, y}); }
            for (let y = 4; y <= 10; y++) { walls.push({x: 7, y}); }
            portals.push({outX: 1, outY: -1, inX: 1, inY: 14, type: 'top'});
            portals.push({outX: 1, outY: 15, inX: 1, inY: 0, type: 'bottom'});
            portals.push({outX: 13, outY: -1, inX: 13, inY: 14, type: 'top'});
            portals.push({outX: 13, outY: 15, inX: 13, inY: 0, type: 'bottom'});
            patrols.push({x: 5, y: 2, dx: 0, dy: 1, minX: 5, maxX: 5, minY: 2, maxY: 12});
            patrols.push({x: 9, y: 12, dx: 0, dy: -1, minX: 9, maxX: 9, minY: 2, maxY: 12});
            patrols.push({x: 1, y: 5, dx: 0, dy: 1, minX: 1, maxX: 1, minY: 2, maxY: 12});
            break;

        case 2: // C («Арена с комнатами»)
            let gCoords = [
                {x:2,y:4},{x:3,y:4},{x:4,y:4},{x:4,y:3},{x:4,y:2},
                {x:12,y:4},{x:11,y:4},{x:10,y:4},{x:10,y:3},{x:10,y:2},
                {x:2,y:10},{x:3,y:10},{x:4,y:10},{x:4,y:11},{x:4,y:12},
                {x:12,y:10},{x:11,y:10},{x:10,y:10},{x:10,y:11},{x:10,y:12}
            ];
            walls.push(...gCoords);
            portals.push({outX: 7, outY: -1, inX: 7, inY: 14, type: 'top'});
            portals.push({outX: 7, outY: 15, inX: 7, inY: 0, type: 'bottom'});
            portals.push({outX: -1, outY: 7, inX: 14, inY: 7, type: 'left'});
            portals.push({outX: 15, outY: 7, inX: 0, inY: 7, type: 'right'});
            patrols.push({x: 5, y: 5, dx: 1, dy: 0, minX: 5, maxX: 9, minY: 5, maxY: 5});
            patrols.push({x: 9, y: 9, dx: -1, dy: 0, minX: 5, maxX: 9, minY: 9, maxY: 9});
            patrols.push({x: 5, y: 9, dx: 0, dy: -1, minX: 5, maxX: 5, minY: 5, maxY: 9});
            patrols.push({x: 9, y: 5, dx: 0, dy: 1, minX: 9, maxX: 9, minY: 5, maxY: 9});
            break;

        case 3: // D («Спираль»)
            for(let x=2; x<=12; x++) { if(x!==7) walls.push({x, y:2}); }
            for(let y=3; y<=12; y++) { if(y!==7) walls.push({x:12, y}); }
            for(let x=4; x<=11; x++) { if(x!==7) walls.push({x, y:12}); }
            for(let y=4; y<=11; y++) { if(y!==7) walls.push({x:4, y}); }
            for(let x=5; x<=10; x++) { if(x!==7) walls.push({x, y:4}); }
            for(let y=5; y<=10; y++) { if(y!==7) walls.push({x:10, y}); }
            portals.push({outX: 7, outY: -1, inX: 7, inY: 14, type: 'top'});
            portals.push({outX: 7, outY: 15, inX: 7, inY: 0, type: 'bottom'});
            portals.push({outX: -1, outY: 7, inX: 14, inY: 7, type: 'left'});
            portals.push({outX: 15, outY: 7, inX: 0, inY: 7, type: 'right'});
            patrols.push({x: 3, y: 3, dx: 1, dy: 0, minX: 3, maxX: 11, minY: 3, maxY: 3});
            patrols.push({x: 11, y: 11, dx: -1, dy: 0, minX: 5, maxX: 11, minY: 11, maxY: 11});
            patrols.push({x: 5, y: 5, dx: 1, dy: 0, minX: 5, maxX: 9, minY: 5, maxY: 5});
            break;

        case 4: // E («Песочные часы»)
            for(let i=0; i<=5; i++) {
                walls.push({x: i, y: i});
                walls.push({x: 14-i, y: i});
                walls.push({x: i, y: 14-i});
                walls.push({x: 14-i, y: 14-i});
            }
            walls = walls.filter(w => w.x >= 3 && w.x <= 11);
            portals.push({outX: -1, outY: 3, inX: 14, inY: 3, type: 'left'});
            portals.push({outX: 15, outY: 3, inX: 0, inY: 3, type: 'right'});
            portals.push({outX: -1, outY: 11, inX: 14, inY: 11, type: 'left'});
            portals.push({outX: 15, outY: 11, inX: 0, inY: 11, type: 'right'});
            patrols.push({x: 6, y: 2, dx: 1, dy: 0, minX: 6, maxX: 8, minY: 2, maxY: 2});
            patrols.push({x: 8, y: 12, dx: -1, dy: 0, minX: 6, maxX: 8, minY: 12, maxY: 12});
            patrols.push({x: 5, y: 4, dx: 1, dy: 0, minX: 5, maxX: 9, minY: 4, maxY: 4});
            patrols.push({x: 9, y: 10, dx: -1, dy: 0, minX: 5, maxX: 9, minY: 10, maxY: 10});
            break;

        case 5: // F («Центральный остров»)
            for(let x=5; x<=9; x++) {
                if (x!==7) { walls.push({x, y:5}); walls.push({x, y:9}); }
            }
            for(let y=6; y<=8; y++) {
                if (y!==7) { walls.push({x:5, y}); walls.push({x:9, y}); }
            }
            let fG = [
                {x:2,y:2},{x:3,y:2},{x:2,y:3},
                {x:12,y:2},{x:11,y:2},{x:12,y:3},
                {x:2,y:12},{x:3,y:12},{x:2,y:11},
                {x:12,y:12},{x:11,y:12},{x:12,y:11}
            ];
            walls.push(...fG);
            portals.push({outX: 3, outY: -1, inX: 3, inY: 14, type: 'top'});
            portals.push({outX: 3, outY: 15, inX: 3, inY: 0, type: 'bottom'});
            portals.push({outX: 11, outY: -1, inX: 11, inY: 14, type: 'top'});
            portals.push({outX: 11, outY: 15, inX: 11, inY: 0, type: 'bottom'});
            patrols.push({x: 7, y: 2, dx: 0, dy: 1, minX: 7, maxX: 7, minY: 2, maxY: 4});
            patrols.push({x: 7, y: 12, dx: 0, dy: -1, minX: 7, maxX: 7, minY: 10, maxY: 12});
            patrols.push({x: 2, y: 7, dx: 1, dy: 0, minX: 2, maxX: 4, minY: 7, maxY: 7});
            patrols.push({x: 12, y: 7, dx: -1, dy: 0, minX: 10, maxX: 12, minY: 7, maxY: 7});
            break;

        case 6: // G («Диагональный излом»)
            for(let i=2; i<=12; i++) {
                if (i%2===0) {
                    walls.push({x: i, y: i});
                    if (i+1 <= 12) walls.push({x: i+1, y: i});
                    if (i-1 >= 2) walls.push({x: i-1, y: i});
                }
            }
            for(let i=2; i<=12; i++) {
                if (i%2!==0) {
                    walls.push({x: i, y: 14-i});
                    if (i+1 <= 12) walls.push({x: i+1, y: 14-i});
                    if (i-1 >= 2) walls.push({x: i-1, y: 14-i});
                }
            }
            walls = walls.filter(w => !(w.x >= 6 && w.x <= 8 && w.y >= 6 && w.y <= 8));
            portals.push({outX: -1, outY: 1, inX: 14, inY: 1, type: 'left'});
            portals.push({outX: 15, outY: 1, inX: 0, inY: 1, type: 'right'});
            portals.push({outX: -1, outY: 13, inX: 14, inY: 13, type: 'left'});
            portals.push({outX: 15, outY: 13, inX: 0, inY: 13, type: 'right'});
            patrols.push({x: 4, y: 4, dx: 1, dy: 0, minX: 4, maxX: 10, minY: 4, maxY: 4});
            patrols.push({x: 10, y: 10, dx: -1, dy: 0, minX: 4, maxX: 10, minY: 10, maxY: 10});
            patrols.push({x: 2, y: 7, dx: 1, dy: 0, minX: 2, maxX: 4, minY: 7, maxY: 7});
            patrols.push({x: 12, y: 7, dx: -1, dy: 0, minX: 10, maxX: 12, minY: 7, maxY: 7});
            break;

        case 7: // H («Близнецы»)
            for(let y=3; y<=11; y++) walls.push({x:3, y});
            for(let x=4; x<=5; x++) { walls.push({x, y:3}); walls.push({x, y:11}); }
            for(let y=3; y<=11; y++) walls.push({x:11, y});
            for(let x=9; x<=10; x++) { walls.push({x, y:3}); walls.push({x, y:11}); }
            portals.push({outX: 7, outY: -1, inX: 7, inY: 14, type: 'top'});
            portals.push({outX: 7, outY: 15, inX: 7, inY: 0, type: 'bottom'});
            portals.push({outX: -1, outY: 7, inX: 14, inY: 7, type: 'left'});
            portals.push({outX: 15, outY: 7, inX: 0, inY: 7, type: 'right'});
            patrols.push({x: 7, y: 3, dx: 0, dy: 1, minX: 7, maxX: 7, minY: 3, maxY: 11});
            patrols.push({x: 1, y: 7, dx: 0, dy: 1, minX: 1, maxX: 1, minY: 3, maxY: 11});
            patrols.push({x: 13, y: 7, dx: 0, dy: -1, minX: 13, maxX: 13, minY: 3, maxY: 11});
            break;

        case 8: // I («Решётка»)
            for (let cx of [1, 5, 9, 13]) {
                for (let cy of [1, 5, 9, 13]) {
                    if ((cx === 1 || cx === 13) && (cy === 1 || cy === 13)) continue;
                    let crossWalls = [
                        {x: cx, y: cy},
                        {x: cx - 1, y: cy},
                        {x: cx + 1, y: cy},
                        {x: cx, y: cy - 1},
                        {x: cx, y: cy + 1}
                    ];
                    for (let w of crossWalls) {
                        if (w.x !== 7 && w.y !== 7) {
                            walls.push(w);
                        }
                    }
                }
            }
            portals.push({outX: 7, outY: -1, inX: 7, inY: 14, type: 'top'});
            portals.push({outX: 7, outY: 15, inX: 7, inY: 0, type: 'bottom'});
            portals.push({outX: -1, outY: 7, inX: 14, inY: 7, type: 'left'});
            portals.push({outX: 15, outY: 7, inX: 0, inY: 7, type: 'right'});
            patrols.push({x: 3, y: 2, dx: 0, dy: 1, minX: 3, maxX: 3, minY: 2, maxY: 12});
            patrols.push({x: 11, y: 12, dx: 0, dy: -1, minX: 11, maxX: 11, minY: 2, maxY: 12});
            patrols.push({x: 2, y: 3, dx: 1, dy: 0, minX: 2, maxX: 12, minY: 3, maxY: 3});
            patrols.push({x: 12, y: 11, dx: -1, dy: 0, minX: 2, maxX: 12, minY: 11, maxY: 11});
            break;

        case 9: // J («Волны»)
            for (let x=0; x<15; x++) {
                if (x !== 3 && x !== 11) {
                    let wy = 2 + (Math.floor(x/3) % 2);
                    walls.push({x, y: wy});
                }
                if (x !== 7) {
                    let wy = 7 + (Math.floor(x/3) % 2);
                    if (!(wy === 7 && x < 4)) {
                        walls.push({x, y: wy});
                    }
                }
                if (x !== 3 && x !== 11) {
                    let wy = 12 + (Math.floor(x/3) % 2);
                    walls.push({x, y: wy});
                }
            }
            portals.push({outX: 3, outY: -1, inX: 3, inY: 14, type: 'top'});
            portals.push({outX: 3, outY: 15, inX: 3, inY: 0, type: 'bottom'});
            portals.push({outX: 11, outY: -1, inX: 11, inY: 14, type: 'top'});
            portals.push({outX: 11, outY: 15, inX: 11, inY: 0, type: 'bottom'});
            patrols.push({x: 5, y: 1, dx: 1, dy: 0, minX: 1, maxX: 13, minY: 1, maxY: 1});
            patrols.push({x: 9, y: 5, dx: -1, dy: 0, minX: 1, maxX: 13, minY: 5, maxY: 5});
            patrols.push({x: 5, y: 10, dx: 1, dy: 0, minX: 1, maxX: 13, minY: 10, maxY: 10});
            break;

        case 10: // K («Окна»)
            for (let i=0; i<15; i++) {
                let isWindowX = (i===2 || i===3 || i===6 || i===7 || i===11 || i===12);
                let isWindowY = (i===2 || i===3 || i===6 || i===7 || i===11 || i===12);
                if (!isWindowY) {
                    walls.push({x: 5, y: i});
                    walls.push({x: 9, y: i});
                }
                if (!isWindowX) {
                    walls.push({x: i, y: 5});
                    walls.push({x: i, y: 9});
                }
            }
            portals.push({outX: -1, outY: 2, inX: 14, inY: 2, type: 'left'});
            portals.push({outX: 15, outY: 2, inX: 0, inY: 2, type: 'right'});
            portals.push({outX: 2, outY: -1, inX: 2, inY: 14, type: 'top'});
            portals.push({outX: 2, outY: 15, inX: 2, inY: 0, type: 'bottom'});
            portals.push({outX: -1, outY: 12, inX: 14, inY: 12, type: 'left'});
            portals.push({outX: 15, outY: 12, inX: 0, inY: 12, type: 'right'});
            portals.push({outX: 12, outY: -1, inX: 12, inY: 14, type: 'top'});
            portals.push({outX: 12, outY: 15, inX: 12, inY: 0, type: 'bottom'});
            patrols.push({x: 2, y: 1, dx: 0, dy: 1, minX: 2, maxX: 2, minY: 1, maxY: 4});
            patrols.push({x: 12, y: 4, dx: 0, dy: -1, minX: 12, maxX: 12, minY: 1, maxY: 4});
            patrols.push({x: 2, y: 13, dx: 0, dy: -1, minX: 2, maxX: 2, minY: 10, maxY: 13});
            patrols.push({x: 12, y: 10, dx: 0, dy: 1, minX: 12, maxX: 12, minY: 10, maxY: 13});
            break;

        case 11: // L («Лабиринт Минотавра»)
            for(let i=5; i<=9; i++) {
                if (i !== 7) { walls.push({x: i, y: 5}); walls.push({x: i, y: 9}); }
                walls.push({x: 5, y: i}); walls.push({x: 9, y: i});
            }
            for(let i=3; i<=11; i++) {
                walls.push({x: i, y: 3}); walls.push({x: i, y: 11});
                if (i !== 7) { walls.push({x: 3, y: i}); walls.push({x: 11, y: i}); }
            }
            for(let i=1; i<=13; i++) {
                if (i !== 7 && i !== 2 && i !== 12) {
                    walls.push({x: i, y: 1}); walls.push({x: i, y: 13});
                    walls.push({x: 1, y: i}); walls.push({x: 13, y: i});
                }
            }
            portals.push({outX: -1, outY: 3, inX: 14, inY: 3, type: 'left'});
            portals.push({outX: 15, outY: 11, inX: 0, inY: 11, type: 'right'});
            portals.push({outX: 4, outY: -1, inX: 4, inY: 14, type: 'top'});
            portals.push({outX: 10, outY: 15, inX: 10, inY: 0, type: 'bottom'});
            patrols.push({x: 4, y: 4, dx: 1, dy: 0, minX: 4, maxX: 10, minY: 4, maxY: 4});
            patrols.push({x: 12, y: 12, dx: 0, dy: -1, minX: 12, maxX: 12, minY: 2, maxY: 12});
            patrols.push({x: 2, y: 12, dx: 1, dy: 0, minX: 2, maxX: 12, minY: 12, maxY: 12});
            break;
    }
}

function getMainConnectedComponent() {
    let startX = 7, startY = 7;
    if (isOccupiedStart(startX, startY)) {
        let found = false;
        for (let x = 0; x < GRID_SIZE && !found; x++) {
            for (let y = 0; y < GRID_SIZE && !found; y++) {
                if (!isOccupiedStart(x, y)) {
                    startX = x;
                    startY = y;
                    found = true;
                }
            }
        }
    }

    let visited = new Set();
    let queue = [{x: startX, y: startY}];
    visited.add(`${startX},${startY}`);

    while(queue.length > 0) {
        let curr = queue.shift();
        
        let neighbors = [
            {x: curr.x + 1, y: curr.y},
            {x: curr.x - 1, y: curr.y},
            {x: curr.x, y: curr.y + 1},
            {x: curr.x, y: curr.y - 1}
        ];

        for(let n of neighbors) {
            let nx = n.x, ny = n.y;
            
            for(let p of portals) {
                if (nx === p.outX && ny === p.outY) {
                    nx = p.inX;
                    ny = p.inY;
                    break;
                }
            }

            if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
            if (isOccupiedStart(nx, ny)) continue;

            let key = `${nx},${ny}`;
            if (!visited.has(key)) {
                visited.add(key);
                queue.push({x: nx, y: ny});
            }
        }
    }
    return visited;
}

function setupSafeStart() {
    if (currentLevel < 9) {
        snake = [
            { x: 3, y: 7 },
            { x: 2, y: 7 },
            { x: 1, y: 7 },
            { x: 0, y: 7 }
        ];
        direction = { x: 1, y: 0 };
        return;
    }
    
    let mainComponent = getMainConnectedComponent();
    
    let centerOptions = [
        {x: 7, y: 7}, {x: 7, y: 6}, {x: 7, y: 8}, {x: 6, y: 7}, {x: 8, y: 7},
        {x: 7, y: 5}, {x: 7, y: 9}, {x: 5, y: 7}, {x: 9, y: 7},
        {x: 7, y: 4}, {x: 7, y: 10}, {x: 4, y: 7}, {x: 10, y: 7}
    ];

    for (let start of centerOptions) {
        let validRight = true;
        for (let i = 0; i < 4; i++) {
            if (start.x - i < 0 || isOccupiedStart(start.x - i, start.y) || !mainComponent.has(`${start.x - i},${start.y}`)) {
                validRight = false; break;
            }
        }
        if (validRight && (start.x + 1 >= GRID_SIZE || isOccupiedStart(start.x + 1, start.y))) validRight = false;
        if (validRight) {
            snake = [];
            for (let i = 0; i < 4; i++) snake.push({x: start.x - i, y: start.y});
            direction = { x: 1, y: 0 };
            return;
        }

        let validLeft = true;
        for (let i = 0; i < 4; i++) {
            if (start.x + i >= GRID_SIZE || isOccupiedStart(start.x + i, start.y) || !mainComponent.has(`${start.x + i},${start.y}`)) {
                validLeft = false; break;
            }
        }
        if (validLeft && (start.x - 1 < 0 || isOccupiedStart(start.x - 1, start.y))) validLeft = false;
        if (validLeft) {
            snake = [];
            for (let i = 0; i < 4; i++) snake.push({x: start.x + i, y: start.y});
            direction = { x: -1, y: 0 };
            return;
        }
        
        let validDown = true;
        for (let i = 0; i < 4; i++) {
            if (start.y - i < 0 || isOccupiedStart(start.x, start.y - i) || !mainComponent.has(`${start.x},${start.y - i}`)) {
                validDown = false; break;
            }
        }
        if (validDown && (start.y + 1 >= GRID_SIZE || isOccupiedStart(start.x, start.y + 1))) validDown = false;
        if (validDown) {
            snake = [];
            for (let i = 0; i < 4; i++) snake.push({x: start.x, y: start.y - i});
            direction = { x: 0, y: 1 };
            return;
        }

        let validUp = true;
        for (let i = 0; i < 4; i++) {
            if (start.y + i >= GRID_SIZE || isOccupiedStart(start.x, start.y + i) || !mainComponent.has(`${start.x},${start.y + i}`)) {
                validUp = false; break;
            }
        }
        if (validUp && (start.y - 1 < 0 || isOccupiedStart(start.x, start.y - 1))) validUp = false;
        if (validUp) {
            snake = [];
            for (let i = 0; i < 4; i++) snake.push({x: start.x, y: start.y + i});
            direction = { x: 0, y: -1 };
            return;
        }
    }
    
    let fallbackFound = false;
    for (let y = 0; y < GRID_SIZE && !fallbackFound; y++) {
        for (let x = 0; x <= GRID_SIZE - 4 && !fallbackFound; x++) {
            let valid = true;
            for (let i = 0; i < 4; i++) {
                if (isOccupiedStart(x + i, y) || !mainComponent.has(`${x + i},${y}`)) {
                    valid = false; break;
                }
            }
            if (valid && (x + 4 >= GRID_SIZE || isOccupiedStart(x + 4, y))) valid = false;
            if (valid) {
                snake = [];
                for (let i = 0; i < 4; i++) snake.push({x: x + 3 - i, y: y});
                direction = { x: 1, y: 0 };
                fallbackFound = true;
            }
        }
    }

    if (!fallbackFound) {
        snake = [{x: 3, y: 7}, {x: 2, y: 7}, {x: 1, y: 7}, {x: 0, y: 7}];
        direction = { x: 1, y: 0 };
    }
}

function isOccupiedStart(x, y) {
    if (walls.some(w => w.x === x && w.y === y)) return true;
    if (patrols.some(p => p.x === x && p.y === y)) return true;
    return false;
}

function isOccupied(x, y) {
    if (snake.some(s => s.x === x && s.y === y)) return true;
    if (walls.some(w => w.x === x && w.y === y)) return true;
    if (patrols.some(p => p.x === x && p.y === y)) return true;
    if (basicFood && basicFood.x === x && basicFood.y === y) return true;
    if (goldenFood && goldenFood.x === x && goldenFood.y === y) return true;
    return false;
}

function getReachableCells(startX, startY) {
    let visited = new Set();
    let queue = [{x: startX, y: startY}];
    visited.add(`${startX},${startY}`);

    while(queue.length > 0) {
        let curr = queue.shift();
        
        let neighbors = [
            {x: curr.x + 1, y: curr.y},
            {x: curr.x - 1, y: curr.y},
            {x: curr.x, y: curr.y + 1},
            {x: curr.x, y: curr.y - 1}
        ];

        for(let n of neighbors) {
            let nx = n.x, ny = n.y;
            
            for(let p of portals) {
                if (nx === p.outX && ny === p.outY) {
                    nx = p.inX;
                    ny = p.inY;
                    break;
                }
            }

            if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
            
            if (snake.some(s => s.x === nx && s.y === ny)) continue;
            if (walls.some(w => w.x === nx && w.y === ny)) continue;
            if (patrols.some(p => p.x === nx && p.y === ny)) continue;

            let key = `${nx},${ny}`;
            if (!visited.has(key)) {
                visited.add(key);
                queue.push({x: nx, y: ny});
            }
        }
    }
    return visited;
}

function countReachableNeighbors(x, y, reachable) {
    let count = 0;
    let neighbors = [
        {x: x + 1, y: y}, {x: x - 1, y: y},
        {x: x, y: y + 1}, {x: x, y: y - 1}
    ];
    for (let n of neighbors) {
        let nx = n.x, ny = n.y;
        for (let p of portals) {
            if (nx === p.outX && ny === p.outY) {
                nx = p.inX;
                ny = p.inY;
                break;
            }
        }
        if (nx >= 0 && nx < GRID_SIZE && ny >= 0 && ny < GRID_SIZE && reachable.has(`${nx},${ny}`))
            count++;
    }
    return count;
}

function isDeadEnd(x, y, reachable) {
    return countReachableNeighbors(x, y, reachable) <= 1;
}

function placeBasicFood() {
    let head = snake[0];
    let reachable = getReachableCells(head.x, head.y);
    let validCells = [];
    let allReachableCells = [];

    for (let x = 0; x < GRID_SIZE; x++) {
        for (let y = 0; y < GRID_SIZE; y++) {
            if (!isOccupied(x, y) && reachable.has(`${x},${y}`) && !isDeadEnd(x, y, reachable)) {
                allReachableCells.push({x, y});
                let dist = Math.abs(x - head.x) + Math.abs(y - head.y);
                if (dist >= 4) {
                    validCells.push({x, y});
                }
            }
        }
    }

    if (validCells.length > 0) {
        let idx = Math.floor(Math.random() * validCells.length);
        basicFood = validCells[idx];
    } else if (allReachableCells.length > 0) {
        let idx = Math.floor(Math.random() * allReachableCells.length);
        basicFood = allReachableCells[idx];
    } else {
        let anyReachable = [];
        for (let x = 0; x < GRID_SIZE; x++) {
            for (let y = 0; y < GRID_SIZE; y++) {
                if (!isOccupied(x, y) && reachable.has(`${x},${y}`))
                    anyReachable.push({x, y});
            }
        }
        if (anyReachable.length > 0) {
            let idx = Math.floor(Math.random() * anyReachable.length);
            basicFood = anyReachable[idx];
        } else {
            basicFood = { x: head.x, y: head.y };
        }
    }
}

function placeGoldenFood() {
    let head = snake[0];
    let reachable = getReachableCells(head.x, head.y);
    let validCells = [];
    let allReachableCells = [];

    for (let x = 0; x < GRID_SIZE; x++) {
        for (let y = 0; y < GRID_SIZE; y++) {
            if (!isOccupied(x, y) && reachable.has(`${x},${y}`) && !isDeadEnd(x, y, reachable)) {
                allReachableCells.push({x, y});
                let dist = Math.abs(x - head.x) + Math.abs(y - head.y);
                if (dist >= 4) {
                    validCells.push({x, y});
                }
            }
        }
    }

    goldenFoodTicks = 0;
    if (validCells.length > 0) {
        let idx = Math.floor(Math.random() * validCells.length);
        goldenFood = validCells[idx];
    } else if (allReachableCells.length > 0) {
        let idx = Math.floor(Math.random() * allReachableCells.length);
        goldenFood = allReachableCells[idx];
    } else {
        let anyReachable = [];
        for (let x = 0; x < GRID_SIZE; x++) {
            for (let y = 0; y < GRID_SIZE; y++) {
                if (!isOccupied(x, y) && reachable.has(`${x},${y}`))
                    anyReachable.push({x, y});
            }
        }
        if (anyReachable.length > 0) {
            let idx = Math.floor(Math.random() * anyReachable.length);
            goldenFood = anyReachable[idx];
        } else {
            goldenFood = null;
        }
    }
}

function render() {
    boardEl.innerHTML = '';

    // Portals
    portals.forEach(p => {
        let el = document.createElement('div');
        el.className = `portal ${p.type}`;
        
        let drawX = p.type === 'left' ? 0 : p.type === 'right' ? 14 : p.outX;
        let drawY = p.type === 'top' ? 0 : p.type === 'bottom' ? 14 : p.outY;
        
        if (p.type === 'left') { el.style.left = `0%`; el.style.top = `${p.outY * (100 / GRID_SIZE)}%`; }
        if (p.type === 'right') { el.style.left = `${14 * (100 / GRID_SIZE)}%`; el.style.top = `${p.outY * (100 / GRID_SIZE)}%`; }
        if (p.type === 'top') { el.style.left = `${p.outX * (100 / GRID_SIZE)}%`; el.style.top = `0%`; }
        if (p.type === 'bottom') { el.style.left = `${p.outX * (100 / GRID_SIZE)}%`; el.style.top = `${14 * (100 / GRID_SIZE)}%`; }
        el.style.width = `${100 / GRID_SIZE}%`;
        el.style.height = `${100 / GRID_SIZE}%`;
        
        if (activeTeleport) {
            let isEntry = p === activeTeleport;
            let isExit = (drawX === activeTeleport.inX && drawY === activeTeleport.inY);
            if (isEntry || isExit) {
                el.classList.add('teleport-pulse');
            }
        }
        
        boardEl.appendChild(el);
    });

    // Walls
    walls.forEach(w => {
        let el = document.createElement('div');
        el.className = 'wall';
        el.style.left = `${w.x * (100 / GRID_SIZE)}%`;
        el.style.top = `${w.y * (100 / GRID_SIZE)}%`;
        el.style.width = `${100 / GRID_SIZE}%`;
        el.style.height = `${100 / GRID_SIZE}%`;
        // +1px for dense overlap
        el.style.width = `calc(${100 / GRID_SIZE}% + 1px)`;
        el.style.height = `calc(${100 / GRID_SIZE}% + 1px)`;
        boardEl.appendChild(el);
    });

    // Patrols
    patrols.forEach(p => {
        let el = document.createElement('div');
        el.className = 'patrol';
        el.style.left = `${p.x * (100 / GRID_SIZE)}%`;
        el.style.top = `${p.y * (100 / GRID_SIZE)}%`;
        el.style.width = `${100 / GRID_SIZE}%`;
        el.style.height = `${100 / GRID_SIZE}%`;
        boardEl.appendChild(el);
    });

    // Basic Food
    if (basicFood) {
        let el = document.createElement('div');
        el.className = 'food';
        el.style.left = `${basicFood.x * (100 / GRID_SIZE)}%`;
        el.style.top = `${basicFood.y * (100 / GRID_SIZE)}%`;
        el.style.width = `${100 / GRID_SIZE}%`;
        el.style.height = `${100 / GRID_SIZE}%`;
        boardEl.appendChild(el);
    }

    // Golden Food
    if (goldenFood) {
        let el = document.createElement('div');
        el.className = 'food golden';
        el.style.left = `${goldenFood.x * (100 / GRID_SIZE)}%`;
        el.style.top = `${goldenFood.y * (100 / GRID_SIZE)}%`;
        el.style.width = `${100 / GRID_SIZE}%`;
        el.style.height = `${100 / GRID_SIZE}%`;
        // Scale/pulse depending on remaining time
        if (goldenFoodTicks > 20) el.style.animation = 'pulseGolden 0.2s infinite alternate ease-in-out';
        boardEl.appendChild(el);
    }

    // Snake
    snake.forEach((segment, index) => {
        let el = document.createElement('div');
        el.className = 'snake-segment';
        if (index === 0) {
            el.classList.add('head');
            if (awaitingFirstInput) el.classList.add('head-blink');
        }
        el.style.left = `${segment.x * (100 / GRID_SIZE)}%`;
        el.style.top = `${segment.y * (100 / GRID_SIZE)}%`;
        el.style.width = `calc(${100 / GRID_SIZE}% + 1px)`;
        el.style.height = `calc(${100 / GRID_SIZE}% + 1px)`;
        el.style.zIndex = 40 + snake.length - index;
        boardEl.appendChild(el);
    });
}

function showCombo() {
    if (comboCount >= 2) {
        comboIndicator.textContent = `Комбо x${comboCount}`;
        comboIndicator.classList.remove('hidden');
        comboIndicator.style.animation = 'none';
        comboIndicator.offsetHeight; // trigger reflow
        comboIndicator.style.animation = null;
    }
}

function hideCombo() {
    comboIndicator.classList.add('hidden');
}

function updateLevelDisplay() {
    levelDisplay.textContent = `УР. ${currentLevel}`;
}

function updateScoreDisplay() {
    scoreDisplay.textContent = formatScore(score);
}

function formatScore(s) {
    return s.toString().padStart(2, '0');
}

function handleKeyPress(e) {
    if (screens.game.classList.contains('active') && !isPaused) {
        switch(e.key) {
            case 'ArrowUp': case 'w': case 'W': queueDirection(0, -1); break;
            case 'ArrowDown': case 's': case 'S': queueDirection(0, 1); break;
            case 'ArrowLeft': case 'a': case 'A': queueDirection(-1, 0); break;
            case 'ArrowRight': case 'd': case 'D': queueDirection(1, 0); break;
        }
    }
}

function setupSwipeControls() {
    let touchStartX = 0;
    let touchStartY = 0;
    
    boardEl.addEventListener('touchstart', e => {
        touchStartX = e.changedTouches[0].screenX;
        touchStartY = e.changedTouches[0].screenY;
    }, {passive: true});
    
    boardEl.addEventListener('touchend', e => {
        let touchEndX = e.changedTouches[0].screenX;
        let touchEndY = e.changedTouches[0].screenY;
        handleSwipe(touchStartX, touchStartY, touchEndX, touchEndY);
    }, {passive: true});
}

function handleSwipe(startX, startY, endX, endY) {
    if (!screens.game.classList.contains('active') || isPaused) return;
    
    const dx = endX - startX;
    const dy = endY - startY;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    
    if (Math.max(absDx, absDy) > 30) {
        if (absDx > absDy) {
            if (dx > 0) queueDirection(1, 0);
            else queueDirection(-1, 0);
        } else {
            if (dy > 0) queueDirection(0, 1);
            else queueDirection(0, -1);
        }
    }
}

function showFloatingText(text, x, y, className) {
    let el = document.createElement('div');
    el.className = `floating-text ${className}`;
    el.textContent = text;
    el.style.left = `${x * (100 / GRID_SIZE)}%`;
    el.style.top = `${y * (100 / GRID_SIZE)}%`;
    boardEl.appendChild(el);
    setTimeout(() => el.remove(), 800);
}

window.__snakeSetLevelForDemo = function(levelNum) {
    isManualSwitch = true;
    levelNum = Math.max(1, Math.min(20, levelNum));
    currentLevel = levelNum;
    updateLevelDisplay();
    setupLevelMap();
    setupSafeStart();
    placeBasicFood();
    goldenFood = null;
    
    // Stop timer for demo/screenshots to keep snake still
    if (gameInterval) {
        clearInterval(gameInterval);
        gameInterval = null;
    }
    
    render();
    isManualSwitch = false;
};

window.__snakeResumeAfterDemo = function() {
    if (!gameInterval && screens.game.classList.contains('active')) {
        gameInterval = setInterval(gameLoop, currentTickRate);
    }
};

init();