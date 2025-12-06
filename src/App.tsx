import React, { useState, useEffect, useRef } from 'react';
import { Hand, RotateCcw, Play, AlertTriangle, Trophy, Volume2, VolumeX } from 'lucide-react';

// --- 类型定义 ---
type GameState = 'IDLE' | 'WAITING' | 'GO' | 'ENDED';
type Player = 'p1' | 'p2' | null;
type WinReason = 'REACTION' | 'FALSE_START' | null;

interface GameLog {
    step: 'WAITING' | 'GO' | 'END';
    timestamp: number;
    winner?: Player;
    winReason?: WinReason;
    reactionTime?: number;
}

// --- 简易音效管理器 (Web Audio API) ---
const playSound = (type: 'start' | 'go' | 'false' | 'win') => {
    try {
        const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
        if (!AudioContext) return;
        
        const ctx = new AudioContext();
        const oscillator = ctx.createOscillator();
        const gainNode = ctx.createGain();

        oscillator.connect(gainNode);
        gainNode.connect(ctx.destination);

        const now = ctx.currentTime;

        if (type === 'start') {
            // 准备开始：短促的提示音
            oscillator.type = 'sine';
            oscillator.frequency.setValueAtTime(440, now);
            oscillator.frequency.exponentialRampToValueAtTime(880, now + 0.1);
            gainNode.gain.setValueAtTime(0.3, now);
            gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.1);
            oscillator.start(now);
            oscillator.stop(now + 0.1);
        } else if (type === 'go') {
            // GO信号：清脆高音
            oscillator.type = 'square';
            oscillator.frequency.setValueAtTime(880, now);
            oscillator.frequency.exponentialRampToValueAtTime(1760, now + 0.1);
            gainNode.gain.setValueAtTime(0.5, now);
            gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
            oscillator.start(now);
            oscillator.stop(now + 0.3);
        } else if (type === 'false') {
            // 抢跑：低沉错误音
            oscillator.type = 'sawtooth';
            oscillator.frequency.setValueAtTime(150, now);
            oscillator.frequency.linearRampToValueAtTime(100, now + 0.3);
            gainNode.gain.setValueAtTime(0.5, now);
            gainNode.gain.linearRampToValueAtTime(0.01, now + 0.3);
            oscillator.start(now);
            oscillator.stop(now + 0.3);
        } else if (type === 'win') {
            // 胜利：简单的上行琶音
            const notes = [523.25, 659.25, 783.99]; // C Major
            notes.forEach((freq, i) => {
                const osc = ctx.createOscillator();
                const gn = ctx.createGain();
                osc.connect(gn);
                gn.connect(ctx.destination);
                osc.type = 'sine';
                osc.frequency.value = freq;
                gn.gain.setValueAtTime(0.2, now + i * 0.1);
                gn.gain.exponentialRampToValueAtTime(0.01, now + i * 0.1 + 0.4);
                osc.start(now + i * 0.1);
                osc.stop(now + i * 0.1 + 0.4);
            });
        }
    } catch (e) {
        console.error("Audio playback failed", e);
    }
};

export default function App() {
    // --- 状态管理 ---
    const [gameState, setGameState] = useState<GameState>('IDLE');
    const [winner, setWinner] = useState<Player>(null);
    const [winReason, setWinReason] = useState<WinReason>(null);
    const [reactionTime, setReactionTime] = useState<number>(0);
    const [soundEnabled, setSoundEnabled] = useState(true);
    
    // 回放相关
    const [gameHistory, setGameHistory] = useState<GameLog[]>([]);
    const [isReplaying, setIsReplaying] = useState(false);
    
    // Refs
    const timerRef = useRef<NodeJS.Timeout | null>(null);
    const startTimeRef = useRef<number>(0);
    const signalTimeRef = useRef<number>(0);
    const stateRef = useRef<GameState>('IDLE');
    const historyRecorder = useRef<GameLog[]>([]);

    useEffect(() => {
        stateRef.current = gameState;
    }, [gameState]);

    // --- 核心逻辑 ---

    const startGame = () => {
        if (isReplaying) return;
        setGameState('WAITING');
        setWinner(null);
        setWinReason(null);
        setReactionTime(0);
        historyRecorder.current = [];
        
        if (soundEnabled) playSound('start');

        const now = Date.now();
        startTimeRef.current = now;
        historyRecorder.current.push({ step: 'WAITING', timestamp: 0 });

        const randomDelay = Math.floor(Math.random() * 4000) + 2000; // 2-6秒

        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(triggerSignal, randomDelay);
    };

    const triggerSignal = () => {
        const now = Date.now();
        signalTimeRef.current = now;
        setGameState('GO');
        if (soundEnabled) playSound('go');
        historyRecorder.current.push({ step: 'GO', timestamp: now - startTimeRef.current });
    };

    const handleAction = (player: 'p1' | 'p2') => {
        if (stateRef.current === 'IDLE' || stateRef.current === 'ENDED' || isReplaying) return;

        const now = Date.now();
        const currentHistory = historyRecorder.current;

        if (stateRef.current === 'WAITING') {
            // 抢跑
            if (timerRef.current) clearTimeout(timerRef.current);
            const opponent = player === 'p1' ? 'p2' : 'p1';
            endGame(opponent, 'FALSE_START', 0);
            if (soundEnabled) playSound('false');
            
            currentHistory.push({
                step: 'END',
                timestamp: now - startTimeRef.current,
                winner: opponent,
                winReason: 'FALSE_START'
            });
        } else if (stateRef.current === 'GO') {
            // 获胜
            const timeDiff = now - signalTimeRef.current;
            endGame(player, 'REACTION', timeDiff);
            if (soundEnabled) playSound('win');
            
            currentHistory.push({
                step: 'END',
                timestamp: now - startTimeRef.current,
                winner: player,
                winReason: 'REACTION',
                reactionTime: timeDiff
            });
        }
        setGameHistory([...currentHistory]);
    };

    const endGame = (winnerPlayer: Player, reason: WinReason, time: number) => {
        setGameState('ENDED');
        setWinner(winnerPlayer);
        setWinReason(reason);
        setReactionTime(time);
    };

    const startReplay = () => {
        if (gameHistory.length === 0 || gameState !== 'ENDED') return;
        setIsReplaying(true);
        setGameState('IDLE'); 
        setWinner(null);
        setWinReason(null);
        setReactionTime(0);

        const waitingFrame = gameHistory.find(h => h.step === 'WAITING');
        const endFrame = gameHistory.find(h => h.step === 'END');
        const goFrame = gameHistory.find(h => h.step === 'GO');

        if (!waitingFrame || !endFrame) {
            setIsReplaying(false);
            return;
        }

        setGameState('WAITING');
        // 回放不播放声音，以免混淆

        const goDelay = goFrame ? (goFrame.timestamp - waitingFrame.timestamp) : -1;
        const endDelay = endFrame.timestamp - waitingFrame.timestamp;

        if (goDelay > 0) {
            setTimeout(() => { if(isReplaying) setGameState('GO'); }, goDelay);
        }

        setTimeout(() => {
            setGameState('ENDED');
            setWinner(endFrame.winner || null);
            setWinReason(endFrame.winReason || null);
            setReactionTime(endFrame.reactionTime || 0);
            setIsReplaying(false);
        }, endDelay);
    };

    // 键盘监听
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.repeat) return;
            if (e.key.toLowerCase() === 'a') handleAction('p1');
            if (e.key.toLowerCase() === 'l') handleAction('p2');
            if (e.code === 'Space' && gameState === 'IDLE' && !isReplaying) startGame();
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [gameState, isReplaying]);


    // --- 子组件：玩家区域 ---
    const PlayerZone = ({ id, label, colorClass, keyLabel }: { id: 'p1' | 'p2', label: string, colorClass: string, keyLabel: string }) => {
        const isWinner = gameState === 'ENDED' && winner === id;
        const isLoser = gameState === 'ENDED' && winner !== id && winner !== null;
        
        let bgColor = colorClass;
        if (gameState === 'ENDED') {
            if (isWinner) bgColor = id === 'p1' ? 'bg-rose-500' : 'bg-sky-500';
            else if (isLoser) bgColor = 'bg-gray-100 grayscale opacity-40';
        }
        if (isReplaying && gameState === 'ENDED' && !isWinner) bgColor = 'bg-gray-200 opacity-30';

        // 旋转逻辑：手机端(md以下) P1 旋转 180度，桌面端(md及以上) 不旋转
        const rotationClass = id === 'p1' ? 'rotate-180 md:rotate-0' : '';

        return (
            <div 
                className={`flex-1 relative flex flex-col items-center justify-center transition-all duration-300 touch-manipulation select-none overflow-hidden ${bgColor}`}
                onPointerDown={(e) => {
                    e.preventDefault();
                    handleAction(id);
                }}
            >
                {/* 旋转容器 */}
                <div className={`flex flex-col items-center justify-center w-full h-full p-4 ${rotationClass}`}>
                    
                    {/* 状态图标 */}
                    <div className={`transform transition-all duration-300 ${isWinner ? 'scale-125 -translate-y-4' : ''}`}>
                        {isLoser && winReason === 'FALSE_START' ? (
                             <div className="flex flex-col items-center text-red-500/80 font-bold animate-pulse">
                                <AlertTriangle size={80} />
                                <span className="text-2xl mt-2">抢跑!</span>
                            </div>
                        ) : (
                            <Hand 
                                size={isWinner ? 140 : 100} 
                                strokeWidth={1.5} 
                                className={`${isWinner ? 'text-white fill-white/20' : 'text-gray-800/20'} transition-colors duration-300`} 
                            />
                        )}
                    </div>

                    {/* 文字标签 */}
                    <div className={`mt-6 text-center z-10 ${isWinner ? 'text-white' : 'text-gray-600/60'}`}>
                        <h2 className="text-3xl font-black tracking-wider">{label}</h2>
                        <p className="text-sm font-medium mt-1 opacity-70 hidden md:block">
                            {keyLabel}
                        </p>
                    </div>

                    {isWinner && (
                        <div className="absolute animate-bounce mt-32">
                            <Trophy size={48} className="text-yellow-300 drop-shadow-md" fill="currentColor" />
                        </div>
                    )}
                </div>
            </div>
        );
    };

    return (
        <div className="w-full h-screen flex flex-col bg-white overflow-hidden font-sans">
            
            {/* 顶部简易栏 */}
            <div className="h-14 bg-white/80 backdrop-blur shadow-sm flex items-center justify-between px-4 z-30 shrink-0 absolute top-0 left-0 right-0 w-full pointer-events-none">
                <div className="font-bold text-gray-400 text-sm flex items-center gap-1 pointer-events-auto">
                    <Hand size={16}/> <span className="hidden sm:inline">举手对决</span>
                </div>
                
                {/* 顶部操作按钮 */}
                <div className="flex gap-2 pointer-events-auto">
                     <button 
                        onClick={() => setSoundEnabled(!soundEnabled)}
                        className="p-2 text-gray-400 hover:text-gray-600 rounded-full"
                    >
                        {soundEnabled ? <Volume2 size={18} /> : <VolumeX size={18} />}
                    </button>
                    {gameState === 'ENDED' && !isReplaying && (
                        <button 
                            onClick={startGame}
                            className="p-2 bg-indigo-600 active:bg-indigo-700 text-white rounded-full shadow-sm"
                        >
                            <RotateCcw size={18} />
                        </button>
                    )}
                </div>
            </div>

            {/* IDLE 状态引导层 */}
            {gameState === 'IDLE' && !isReplaying && (
                <div className="absolute inset-0 z-50 bg-white/95 backdrop-blur-md flex flex-col items-center justify-center p-6 text-center animate-fade-in">
                    <div className="mb-8">
                        <div className="inline-block p-4 bg-indigo-100 rounded-full mb-4 text-indigo-600">
                            <Hand size={48} strokeWidth={2} />
                        </div>
                        <h1 className="text-3xl font-black text-gray-800 mb-2">双人反应对决</h1>
                        <p className="text-gray-500 max-w-xs mx-auto text-sm leading-relaxed">
                            两人各执一端。看到屏幕中央出现 <strong className="text-green-600 text-lg">GO</strong> 信号时，立即点击。
                        </p>
                    </div>

                    <button 
                        onClick={startGame}
                        className="w-full max-w-xs py-4 bg-indigo-600 hover:bg-indigo-700 active:scale-95 text-white text-lg font-bold rounded-xl shadow-xl shadow-indigo-200 transition-all flex items-center justify-center gap-2"
                    >
                        <Play size={24} fill="currentColor" />
                        立即开始
                    </button>
                    
                     <div className="mt-8 flex gap-4 text-xs text-gray-400 font-medium">
                         {/* 电脑端提示 */}
                        <span className="hidden md:inline">键盘操作: 'A' (红方) vs 'L' (蓝方)</span>
                        {/* 手机端提示 */}
                        <span className="md:hidden">手机操作: 点击各自半区</span>
                    </div>
                </div>
            )}

            {/* 游戏主区域 */}
            <div className="flex-1 flex flex-col md:flex-row relative">
                
                {/* --- 中央信号指示器 (核心改进) --- */}
                {gameState !== 'IDLE' && (
                    <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 z-40 pointer-events-none flex flex-col items-center justify-center">
                        
                        {/* VS 徽章 (Waiting阶段显示) */}
                        {gameState === 'WAITING' && (
                            <div className="bg-white p-2 rounded-full shadow-lg border-4 border-gray-100 animate-pulse">
                                <div className="w-16 h-16 md:w-24 md:h-24 rounded-full bg-orange-500 flex items-center justify-center text-white font-black text-xl md:text-2xl shadow-inner">
                                    ...
                                </div>
                                <div className="absolute top-full mt-2 left-1/2 -translate-x-1/2 whitespace-nowrap bg-orange-100 text-orange-600 text-xs px-2 py-1 rounded font-bold">
                                    等待信号
                                </div>
                            </div>
                        )}

                        {/* GO 信号 */}
                        {gameState === 'GO' && (
                            <div className="animate-bounce">
                                <div className="w-24 h-24 md:w-32 md:h-32 rounded-full bg-green-500 flex items-center justify-center text-white font-black text-3xl md:text-5xl shadow-2xl ring-8 ring-green-200">
                                    GO!
                                </div>
                            </div>
                        )}

                        {/* 结果展示 */}
                        {gameState === 'ENDED' && (
                            <div className="flex flex-col items-center bg-white p-4 rounded-2xl shadow-2xl border border-gray-100 animate-pop-in">
                                <div className={`text-2xl md:text-3xl font-black mb-1 ${winner === 'p1' ? 'text-rose-600' : 'text-sky-600'}`}>
                                    {winner === 'p1' ? '红方胜' : '蓝方胜'}
                                </div>
                                {winReason === 'REACTION' && (
                                    <div className="text-xl font-mono font-bold text-gray-700 bg-gray-100 px-3 py-1 rounded-lg">
                                        {reactionTime} <span className="text-xs text-gray-500">ms</span>
                                    </div>
                                )}
                                {winReason === 'FALSE_START' && (
                                    <div className="text-red-500 font-bold text-sm">
                                        对方抢跑犯规
                                    </div>
                                )}
                                {isReplaying && (
                                    <div className="mt-2 text-xs font-bold text-yellow-600 bg-yellow-100 px-2 py-0.5 rounded flex items-center gap-1">
                                        <RotateCcw size={10} /> 回放中
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                )}


                {/* 玩家 1 (红方) */}
                <PlayerZone 
                    id="p1" 
                    label="P1 红方" 
                    keyLabel="键盘 'A'"
                    colorClass="bg-rose-50" 
                />

                {/* 分割线 - 视觉辅助 */}
                <div className="absolute inset-0 pointer-events-none z-10 flex md:flex-row flex-col">
                    <div className="md:w-1/2 w-full h-1/2 md:h-full border-b md:border-b-0 md:border-r border-gray-200/50"></div>
                </div>

                {/* 玩家 2 (蓝方) */}
                <PlayerZone 
                    id="p2" 
                    label="P2 蓝方" 
                    keyLabel="键盘 'L'"
                    colorClass="bg-sky-50" 
                />
                
                {/* 底部回放按钮 */}
                {gameState === 'ENDED' && !isReplaying && gameHistory.length > 0 && (
                     <div className="absolute bottom-8 left-1/2 transform -translate-x-1/2 z-30 pointer-events-auto">
                        <button 
                            onClick={startReplay}
                            className="flex items-center gap-2 px-5 py-2 bg-white/90 backdrop-blur border border-gray-200 text-gray-600 hover:bg-gray-50 rounded-full text-sm font-bold shadow-lg active:scale-95 transition-all"
                        >
                            <RotateCcw size={14} />
                            看回放
                        </button>
                     </div>
                )}
            </div>
        </div>
    );
}