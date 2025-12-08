import React, { useState, useEffect, useRef } from 'react';
import { Hand, RotateCcw, Play, AlertTriangle, Trophy, Volume2, VolumeX, Mic, MicOff, User, Activity, RefreshCw, BarChart3, Loader2, Music, Zap } from 'lucide-react';

// --- 类型定义 ---
type GameState = 'IDLE' | 'WAITING' | 'GO' | 'ENDED';
type Player = 'p1' | 'p2' | null;
type WinReason = 'REACTION' | 'FALSE_START' | 'VOICE_TRIGGER' | null;
type GameMode = 'TOUCH' | 'VOICE';

interface GameLog {
    step: 'WAITING' | 'GO' | 'END';
    timestamp: number;
    winner?: Player;
    winReason?: WinReason;
    reactionTime?: number;
    audioBlob?: Blob;
    detectedPitch?: number;
    blobSize?: number;
    recordingStartTime?: number; 
    triggerTimestamp?: number; 
    signalTimestamp?: number; 
}

// --- 简单的 Canvas 礼花组件 ---
const Confetti = () => {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;

        const particles: any[] = [];
        const colors = ['#FFC700', '#FF0000', '#2E3192', '#41BBC7', '#73FF00', '#FF00EA'];

        for (let i = 0; i < 150; i++) {
            particles.push({
                x: window.innerWidth / 2,
                y: window.innerHeight / 2,
                w: Math.random() * 10 + 5,
                h: Math.random() * 10 + 5,
                vx: (Math.random() - 0.5) * 20,
                vy: (Math.random() - 0.5) * 20,
                color: colors[Math.floor(Math.random() * colors.length)],
                gravity: 0.1 + Math.random() * 0.2,
                rotation: Math.random() * 360,
                rotationSpeed: (Math.random() - 0.5) * 10
            });
        }

        let animationId: number;
        const render = () => {
            if (!canvas || !ctx) return;
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            particles.forEach((p, index) => {
                p.x += p.vx;
                p.y += p.vy;
                p.vy += p.gravity;
                p.rotation += p.rotationSpeed;
                p.vx *= 0.96; // 阻力
                p.vy *= 0.96;

                ctx.save();
                ctx.translate(p.x, p.y);
                ctx.rotate((p.rotation * Math.PI) / 180);
                ctx.fillStyle = p.color;
                ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
                ctx.restore();

                if (p.y > canvas.height) particles.splice(index, 1);
            });

            if (particles.length > 0) {
                animationId = requestAnimationFrame(render);
            }
        };
        render();

        return () => cancelAnimationFrame(animationId);
    }, []);

    return <canvas ref={canvasRef} className="absolute inset-0 pointer-events-none z-50" />;
};

// --- 工具函数：安全播放音频 ---
const safePlaySound = (type: 'start' | 'go' | 'false' | 'win' | 'test', mode: GameMode) => {
    // 声音模式下GO不发声，避免触发麦克风
    if (mode === 'VOICE' && type === 'go') return; 
    try {
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        if (!AudioContextClass) return;
        const ctx = new AudioContextClass();
        const oscillator = ctx.createOscillator();
        const gainNode = ctx.createGain();
        oscillator.connect(gainNode);
        gainNode.connect(ctx.destination);
        const now = ctx.currentTime;

        if (type === 'start') {
            oscillator.type = 'sine';
            oscillator.frequency.setValueAtTime(440, now);
            oscillator.frequency.exponentialRampToValueAtTime(880, now + 0.1);
            gainNode.gain.setValueAtTime(0.3, now);
            gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.1);
            oscillator.start(now);
            oscillator.stop(now + 0.1);
        } else if (type === 'go') {
            oscillator.type = 'square';
            oscillator.frequency.setValueAtTime(880, now);
            gainNode.gain.setValueAtTime(0.5, now);
            gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
            oscillator.start(now);
            oscillator.stop(now + 0.3);
        } else if (type === 'test') {
            oscillator.type = 'triangle';
            oscillator.frequency.setValueAtTime(440, now);
            gainNode.gain.setValueAtTime(0.5, now);
            gainNode.gain.linearRampToValueAtTime(0.01, now + 0.5);
            oscillator.start(now);
            oscillator.stop(now + 0.5);
        } else if (type === 'win') {
            const notes = [523.25, 659.25, 783.99]; 
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
        } else { 
            oscillator.type = 'sawtooth';
            oscillator.frequency.setValueAtTime(150, now);
            gainNode.gain.setValueAtTime(0.5, now);
            gainNode.gain.linearRampToValueAtTime(0.01, now + 0.3);
            oscillator.start(now);
            oscillator.stop(now + 0.3);
        }
    } catch (e) {
        console.error("Sound play error", e);
    }
};

// --- 工具函数：音高检测 ---
const detectPitch = (buffer: Float32Array, sampleRate: number): number => {
    const SIZE = buffer.length;
    let rms = 0;
    for (let i = 0; i < SIZE; i++) rms += buffer[i] * buffer[i];
    rms = Math.sqrt(rms / SIZE);
    if (rms < 0.02) return -1; 

    let bestOffset = -1;
    let bestCorrelation = 0;
    let lastCorrelation = 1;

    for (let offset = 0; offset < SIZE; offset++) {
        let correlation = 0;
        for (let i = 0; i < SIZE - offset; i += 2) {
            correlation += Math.abs(buffer[i] - buffer[i + offset]);
        }
        correlation = 1 - (correlation / (SIZE / 2));
        
        if (correlation > 0.9 && correlation > lastCorrelation) {
            if (correlation > bestCorrelation) {
                bestCorrelation = correlation;
                bestOffset = offset;
            }
        }
        lastCorrelation = correlation;
    }
    if (bestCorrelation > 0.01 && bestOffset > 0) {
        return sampleRate / bestOffset;
    }
    return -1;
};

export default function App() {
    // --- 状态 ---
    const [gameState, setGameState] = useState<GameState>('IDLE');
    const [gameMode, setGameMode] = useState<GameMode>('TOUCH'); 
    const [winner, setWinner] = useState<Player>(null);
    const [winReason, setWinReason] = useState<WinReason>(null);
    const [reactionTime, setReactionTime] = useState<number>(0);
    const [soundEnabled, setSoundEnabled] = useState(true);
    const [detectedFreq, setDetectedFreq] = useState<number>(0); 
    const [currentVolume, setCurrentVolume] = useState<number>(0); 
    
    // Debug & 状态标识
    const [isMicInitialized, setIsMicInitialized] = useState(false);
    const [isSavingAudio, setIsSavingAudio] = useState(false);
    const [lastRecordingSize, setLastRecordingSize] = useState<number>(0);

    // 回放相关
    const [gameHistory, setGameHistory] = useState<GameLog[]>([]);
    const [isReplaying, setIsReplaying] = useState(false);
    const [replayShockwave, setReplayShockwave] = useState<Player>(null); 

    // --- Refs ---
    const timerRef = useRef<NodeJS.Timeout | null>(null);
    const startTimeRef = useRef<number>(0);
    const signalTimeRef = useRef<number>(0);
    const signalTimestampRef = useRef<number>(0); 
    const stateRef = useRef<GameState>('IDLE');
    const historyRecorder = useRef<GameLog[]>([]);
    
    // 同步回放状态到 Ref
    const isReplayingRef = useRef(false);

    // 音频核心
    const audioContextRef = useRef<AudioContext | null>(null);
    const analyserRef = useRef<AnalyserNode | null>(null);
    const micStreamRef = useRef<MediaStream | null>(null);
    const animationFrameRef = useRef<number | null>(null);
    
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const audioChunksRef = useRef<Blob[]>([]);
    const recordingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const recordingStartTimeRef = useRef<number>(0);
    const replaySourceRef = useRef<AudioBufferSourceNode | null>(null);
    const replayTimeoutsRef = useRef<NodeJS.Timeout[]>([]); 

    // 同步状态到 Refs
    useEffect(() => { stateRef.current = gameState; }, [gameState]);
    useEffect(() => { isReplayingRef.current = isReplaying; }, [isReplaying]); 

    // 组件卸载清理
    useEffect(() => {
        return () => { fullAudioCleanup(); };
    }, []);

    const fullAudioCleanup = () => {
        if (animationFrameRef.current) {
            cancelAnimationFrame(animationFrameRef.current);
            animationFrameRef.current = null;
        }
        if (timerRef.current) clearTimeout(timerRef.current);
        if (recordingTimeoutRef.current) clearTimeout(recordingTimeoutRef.current);
        
        replayTimeoutsRef.current.forEach(t => clearTimeout(t));
        replayTimeoutsRef.current = [];

        if (replaySourceRef.current) {
            try { replaySourceRef.current.stop(); } catch(e) {}
            replaySourceRef.current = null;
        }
        
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
            mediaRecorderRef.current.stop();
        }
    };

    // --- 音频引擎初始化 ---
    const initAudioEngine = async () => {
        if (micStreamRef.current && audioContextRef.current?.state === 'running') {
            return true; 
        }

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            micStreamRef.current = stream;

            const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
            const ctx = new AudioContextClass();
            audioContextRef.current = ctx;
            await ctx.resume();

            const analyser = ctx.createAnalyser();
            analyser.fftSize = 2048;
            analyserRef.current = analyser;

            const source = ctx.createMediaStreamSource(stream);
            const muteGain = ctx.createGain(); 
            muteGain.gain.value = 0.001; 
            
            source.connect(analyser);
            analyser.connect(muteGain);
            muteGain.connect(ctx.destination);

            setIsMicInitialized(true);
            
            startMonitoringLoop();
            return true;
        } catch (err) {
            console.error("Audio Init Failed", err);
            alert("麦克风启动失败，请检查权限。");
            return false;
        }
    };

    // --- 监听循环 ---
    const startMonitoringLoop = () => {
        if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
        
        const loop = () => {
            if (!analyserRef.current || !audioContextRef.current) return;
            
            if (audioContextRef.current.state === 'suspended') audioContextRef.current.resume();

            const bufferLength = analyserRef.current.fftSize;
            const dataArray = new Float32Array(bufferLength);
            analyserRef.current.getFloatTimeDomainData(dataArray);

            let sum = 0;
            for (let i = 0; i < bufferLength; i++) {
                sum += dataArray[i] * dataArray[i];
            }
            const rms = Math.sqrt(sum / bufferLength);
            
            const displayVol = Math.min(rms * 15, 1.5); 
            setCurrentVolume(displayVol);

            // --- 游戏触发逻辑 ---
            if ((stateRef.current === 'WAITING' || stateRef.current === 'GO') && !isReplayingRef.current) {
                if (rms > 0.02) { 
                    const pitch = detectPitch(dataArray, audioContextRef.current.sampleRate);
                    handleVoiceTrigger(pitch);
                }
            }

            animationFrameRef.current = requestAnimationFrame(loop);
        };
        loop();
    };

    // --- 游戏流程控制 ---

    const startGame = async () => {
        fullAudioCleanup();
        setIsSavingAudio(false); 
        setReplayShockwave(null);
        setIsReplaying(false);
        isReplayingRef.current = false; 

        if (gameMode === 'VOICE') {
            if (!isMicInitialized) {
                const success = await initAudioEngine();
                if (!success) { setGameMode('TOUCH'); return; } 
            }
            
            startMonitoringLoop();
            startRecording(); 
        }

        setGameState('WAITING');
        setWinner(null);
        setWinReason(null);
        setReactionTime(0);
        setDetectedFreq(0);
        setLastRecordingSize(0);
        historyRecorder.current = [];
        
        if (soundEnabled) safePlaySound('start', gameMode);

        const now = Date.now();
        startTimeRef.current = now;
        historyRecorder.current.push({ step: 'WAITING', timestamp: 0 });

        const randomDelay = Math.floor(Math.random() * 4000) + 2000; 
        timerRef.current = setTimeout(triggerSignal, randomDelay);
    };

    const startRecording = () => {
        if (!micStreamRef.current) return;
        audioChunksRef.current = [];
        recordingStartTimeRef.current = Date.now();

        try {
            const recorder = new MediaRecorder(micStreamRef.current);
            recorder.ondataavailable = (e) => {
                if (e.data && e.data.size > 0) audioChunksRef.current.push(e.data);
            };
            recorder.start();
            mediaRecorderRef.current = recorder;
        } catch (e) {
            console.error("Recorder error", e);
        }
    };

    const triggerSignal = () => {
        if (stateRef.current !== 'WAITING') return;

        const now = Date.now();
        signalTimeRef.current = now;
        signalTimestampRef.current = now;
        setGameState('GO');
        if (soundEnabled) safePlaySound('go', gameMode);
        historyRecorder.current.push({ step: 'GO', timestamp: now - startTimeRef.current });
    };

    // --- 胜负判定 ---
    const handleVoiceTrigger = (pitch: number) => {
        if (isReplayingRef.current) return;
        if (stateRef.current !== 'WAITING' && stateRef.current !== 'GO') return;

        setDetectedFreq(Math.round(pitch));
        
        let guessedWinner: Player = 'p1';
        if (pitch > 0) {
            guessedWinner = pitch > 200 ? 'p1' : 'p2'; 
        }
        
        finishGame(guessedWinner, 'VOICE_TRIGGER');
    };

    const handleTouchAction = (player: 'p1' | 'p2') => {
        if (stateRef.current !== 'WAITING' && stateRef.current !== 'GO') return;
        finishGame(player, 'TOUCH');
    };

    const finishGame = (triggerPlayer: Player, triggerType: 'TOUCH' | 'VOICE_TRIGGER') => {
        if (timerRef.current) clearTimeout(timerRef.current);

        const now = Date.now();
        let finalWinner = triggerPlayer;
        let finalReason: WinReason = 'REACTION';
        let timeDiff = 0;

        if (stateRef.current === 'WAITING') {
            finalWinner = triggerPlayer === 'p1' ? 'p2' : 'p1';
            finalReason = 'FALSE_START';
            if (soundEnabled) safePlaySound('false', gameMode);
        } else {
            timeDiff = now - signalTimeRef.current;
            finalReason = 'REACTION';
            if (soundEnabled) safePlaySound('win', gameMode);
        }

        setGameState('ENDED');
        setWinner(finalWinner);
        setWinReason(finalReason);
        setReactionTime(timeDiff);

        const logEntry: GameLog = {
            step: 'END',
            timestamp: now - startTimeRef.current,
            winner: finalWinner,
            winReason: finalReason,
            reactionTime: timeDiff,
            recordingStartTime: recordingStartTimeRef.current,
            triggerTimestamp: now,
            signalTimestamp: signalTimestampRef.current
        };
        historyRecorder.current.push(logEntry);
        setGameHistory([...historyRecorder.current]);

        if (gameMode === 'VOICE') {
            setIsSavingAudio(true);
            recordingTimeoutRef.current = setTimeout(() => {
                stopAndSaveRecording(logEntry);
            }, 1500);
        } else {
            stopAndSaveRecording(logEntry);
        }
    };

    const stopAndSaveRecording = (logEntry: GameLog) => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
            mediaRecorderRef.current.requestData();
            mediaRecorderRef.current.stop();
            
            setTimeout(() => {
                const totalSize = audioChunksRef.current.reduce((acc, chunk) => acc + chunk.size, 0);
                setLastRecordingSize(totalSize);

                if (totalSize > 0) {
                    const mime = mediaRecorderRef.current?.mimeType || 'audio/webm';
                    const blob = new Blob(audioChunksRef.current, { type: mime });
                    logEntry.audioBlob = blob;
                    logEntry.blobSize = totalSize;
                    setGameHistory([...historyRecorder.current]);
                }
                setIsSavingAudio(false); 
            }, 100);
        } else {
            setIsSavingAudio(false);
        }
    };

    // --- 极简回放系统 ---
    const startReplay = async () => {
        if (gameHistory.length === 0 || gameState !== 'ENDED') return;
        
        setIsReplaying(true);
        setReplayShockwave(null);

        const endFrame = gameHistory.find(h => h.step === 'END');
        if (!endFrame) { setIsReplaying(false); return; }

        let seekOffset = 0; 
        let timeToVisualTrigger = 500; 

        if (endFrame.audioBlob && endFrame.recordingStartTime && endFrame.triggerTimestamp) {
            const triggerTime = endFrame.triggerTimestamp;
            const recStart = endFrame.recordingStartTime;
            const idealPlayStart = triggerTime - 500; 
            seekOffset = Math.max(0, (idealPlayStart - recStart) / 1000);
            timeToVisualTrigger = 500; 
        }

        if (endFrame.audioBlob) {
            await playBlobSlice(endFrame.audioBlob, seekOffset);
        }

        const t1 = setTimeout(() => {
            if (!isReplayingRef.current) return;
            setReplayShockwave(endFrame.winner || null);
        }, timeToVisualTrigger);

        const t2 = setTimeout(() => {
            setIsReplaying(false);
            setReplayShockwave(null);
            if (replaySourceRef.current) {
                try { replaySourceRef.current.stop(); } catch(e){}
            }
        }, timeToVisualTrigger + 2000); 

        replayTimeoutsRef.current.push(t1, t2);
    };

    const playBlobSlice = async (blob: Blob, offset: number) => {
        try {
            const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
            const arrayBuffer = await blob.arrayBuffer();
            const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

            const source = ctx.createBufferSource();
            source.buffer = audioBuffer;

            const gainNode = ctx.createGain();
            gainNode.gain.value = 8.0; 

            source.connect(gainNode);
            gainNode.connect(ctx.destination);

            replaySourceRef.current = source;
            source.start(0, offset); 
        } catch (e) {
            console.error("Replay Error", e);
        }
    };

    // 键盘监听
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.repeat) return;
            if (gameMode === 'VOICE' && gameState !== 'IDLE') return; 
            if (e.key.toLowerCase() === 'a') handleTouchAction('p1');
            if (e.key.toLowerCase() === 'l') handleTouchAction('p2');
            if (e.code === 'Space' && gameState === 'IDLE' && !isReplaying) startGame();
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [gameState, isReplaying, gameMode]);

    // --- UI 组件 ---
    const PlayerZone = ({ id, label, colorClass, keyLabel, subLabel }: { id: 'p1' | 'p2', label: string, colorClass: string, keyLabel: string, subLabel?: string }) => {
        const isWinner = gameState === 'ENDED' && winner === id;
        const isLoser = gameState === 'ENDED' && winner !== id && winner !== null;
        let bgColor = colorClass;
        if (gameState === 'ENDED') {
            if (isWinner) bgColor = id === 'p1' ? 'bg-rose-500' : 'bg-sky-500';
            else if (isLoser) bgColor = 'bg-gray-100 grayscale opacity-40';
        }
        if (isReplaying && gameState === 'ENDED' && !isWinner) bgColor = 'bg-gray-200 opacity-30';
        const rotationClass = id === 'p1' ? 'rotate-180 md:rotate-0' : '';
        const showShockwave = isReplaying && replayShockwave === id;

        // 决定显示的图标
        let IconComponent;
        if (isWinner) {
            // 胜利时：直接显示大奖杯，替换原有的手/麦克风
            IconComponent = <Trophy size={140} className="text-yellow-300 drop-shadow-lg animate-bounce" fill="currentColor" />;
        } else if (gameMode === 'VOICE') {
            // 非胜利（准备、进行中、或失败）：显示麦克风
            IconComponent = <Mic size={100} className="text-gray-800/20 transition-colors duration-300" />;
        } else {
            // 非胜利：显示手掌
            IconComponent = <Hand size={100} strokeWidth={1.5} className="text-gray-800/20 transition-colors duration-300" />;
        }

        return (
            <div 
                className={`flex-1 relative flex flex-col items-center justify-center transition-all duration-300 touch-manipulation select-none overflow-hidden ${bgColor}`}
                onPointerDown={(e) => {
                    if (gameMode === 'TOUCH') { e.preventDefault(); handleTouchAction(id); }
                }}
            >
                <div className={`flex flex-col items-center justify-center w-full h-full p-4 ${rotationClass}`}>
                    <div className={`transform transition-all duration-300 ${isWinner ? 'scale-125 -translate-y-4' : ''}`}>
                        {isLoser && winReason === 'FALSE_START' ? (
                             <div className="flex flex-col items-center text-red-500/80 font-bold animate-pulse">
                                <AlertTriangle size={80} /> <span className="text-2xl mt-2">抢跑!</span>
                            </div>
                        ) : (
                            <div className="relative">
                                {showShockwave && (
                                    <>
                                        <div className="absolute inset-0 rounded-full bg-white opacity-80 animate-ping" style={{ animationDuration: '0.6s' }}></div>
                                        <div className="absolute -inset-12 rounded-full border-4 border-white opacity-60 animate-ping" style={{ animationDuration: '1s' }}></div>
                                        <div className="absolute -inset-20 flex items-center justify-center z-20">
                                            <Zap size={120} className="text-yellow-300 drop-shadow-lg animate-pulse" fill="currentColor"/>
                                        </div>
                                    </>
                                )}
                                {IconComponent}
                            </div>
                        )}
                    </div>
                    <div className={`mt-6 text-center z-10 ${isWinner ? 'text-white' : 'text-gray-600/60'}`}>
                        <h2 className="text-3xl font-black tracking-wider">{label}</h2>
                        {gameMode === 'VOICE' && subLabel && !showShockwave && (
                            <p className={`text-sm font-bold mt-1 ${isWinner ? 'text-white/90' : 'text-gray-500'}`}>{subLabel}</p>
                        )}
                        <p className="text-sm font-medium mt-1 opacity-70 hidden md:block">{gameMode === 'VOICE' ? '喊出声音!' : keyLabel}</p>
                    </div>
                </div>
            </div>
        );
    };

    return (
        <div className="w-full h-screen flex flex-col bg-white overflow-hidden font-sans relative">
            {/* 撒礼花特效 */}
            {(gameState === 'ENDED' || isReplaying) && winner && winReason !== 'FALSE_START' && <Confetti />}

            <div className="h-14 bg-white/80 backdrop-blur shadow-sm flex items-center justify-between px-4 z-30 shrink-0 absolute top-0 left-0 right-0 w-full pointer-events-none">
                <div className="font-bold text-gray-400 text-sm flex items-center gap-1 pointer-events-auto">
                     {gameMode === 'VOICE' ? <Mic size={16}/> : <Hand size={16}/>}
                     <span className="hidden sm:inline">{gameMode === 'VOICE' ? '声控对决' : '举手对决'}</span>
                </div>
                <div className="flex gap-2 pointer-events-auto">
                     <button onClick={() => setSoundEnabled(!soundEnabled)} className="p-2 text-gray-400 hover:text-gray-600 rounded-full">
                        {soundEnabled ? <Volume2 size={18} /> : <VolumeX size={18} />}
                    </button>
                    {gameState === 'ENDED' && !isReplaying && (
                        <button onClick={startGame} className={`p-2 rounded-full shadow-sm transition-all text-white ${isSavingAudio ? 'bg-gray-400 cursor-not-allowed' : 'bg-indigo-600 active:bg-indigo-700'}`} disabled={isSavingAudio}>
                            {isSavingAudio ? <Loader2 size={18} className="animate-spin" /> : <RotateCcw size={18} />}
                        </button>
                    )}
                </div>
            </div>

            {gameState === 'IDLE' && !isReplaying && (
                <div className="absolute inset-0 z-40 bg-white/95 backdrop-blur-md flex flex-col items-center justify-center p-6 text-center animate-fade-in">
                    <div className="flex bg-gray-100 p-1 rounded-xl mb-6">
                        <button onClick={() => setGameMode('TOUCH')} className={`px-6 py-2 rounded-lg text-sm font-bold transition-all flex items-center gap-2 ${gameMode === 'TOUCH' ? 'bg-white shadow-sm text-indigo-600' : 'text-gray-400'}`}>
                            <Hand size={16} /> 触摸模式
                        </button>
                        <button onClick={() => setGameMode('VOICE')} className={`px-6 py-2 rounded-lg text-sm font-bold transition-all flex items-center gap-2 ${gameMode === 'VOICE' ? 'bg-white shadow-sm text-rose-500' : 'text-gray-400'}`}>
                            <Mic size={16} /> 声音模式
                        </button>
                    </div>

                    <div className="mb-6">
                        <h1 className="text-3xl font-black text-gray-800 mb-2">{gameMode === 'VOICE' ? '谁先发声谁赢' : '双人反应对决'}</h1>
                        <p className="text-gray-500 max-w-xs mx-auto text-sm">
                            {gameMode === 'VOICE' ? '看到 GO 信号时，立即喊出声音。' : '看到 GO 信号时，立即点击屏幕。'}
                        </p>
                    </div>

                    {gameMode === 'VOICE' && (
                        <div className="mb-8 w-full max-w-xs bg-gray-50 p-4 rounded-xl border border-gray-200">
                            <div className="flex justify-between items-center mb-2 text-xs font-bold text-gray-500">
                                <span className="flex items-center gap-1"><BarChart3 size={12}/> 麦克风预检</span>
                                <span className={isMicInitialized ? "text-green-500" : "text-gray-400"}>{isMicInitialized ? "工作中" : "未启动"}</span>
                            </div>
                            <div className="h-3 bg-gray-200 rounded-full overflow-hidden relative">
                                <div className="absolute left-0 top-0 bottom-0 bg-green-500 transition-all duration-75" style={{ width: `${Math.min(currentVolume * 100, 100)}%` }}></div>
                                <div className="absolute top-0 bottom-0 w-0.5 bg-red-400 left-[2%] z-10"></div> 
                            </div>
                            <div className="mt-3 flex gap-2">
                                {!isMicInitialized ? (
                                    <button onClick={initAudioEngine} className="flex-1 py-2 bg-gray-800 text-white text-xs font-bold rounded hover:bg-black transition-colors">启动麦克风</button>
                                ) : (
                                    <>
                                        <button onClick={() => initAudioEngine()} className="flex-1 py-2 bg-white border border-gray-300 text-gray-600 text-xs font-bold rounded hover:bg-gray-50 flex items-center justify-center gap-1"><RefreshCw size={10}/> 重置</button>
                                        <button onClick={() => safePlaySound('test', 'VOICE')} className="flex-1 py-2 bg-white border border-gray-300 text-gray-600 text-xs font-bold rounded hover:bg-gray-50 flex items-center justify-center gap-1"><Music size={10}/> 试听</button>
                                    </>
                                )}
                            </div>
                        </div>
                    )}

                    <button onClick={startGame} className={`w-full max-w-xs py-4 text-white text-lg font-bold rounded-xl shadow-xl transition-all flex items-center justify-center gap-2 active:scale-95 ${gameMode === 'VOICE' ? 'bg-rose-500 hover:bg-rose-600 shadow-rose-200' : 'bg-indigo-600 hover:bg-indigo-700 shadow-indigo-200'}`}>
                        <Play size={24} fill="currentColor" /> 立即开始
                    </button>
                </div>
            )}

            <div className="flex-1 flex flex-col md:flex-row relative">
                {gameState !== 'IDLE' && (
                    <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 z-40 pointer-events-none flex flex-col items-center justify-center">
                        {gameState === 'WAITING' && (
                            <div className="bg-white p-2 rounded-full shadow-lg border-4 border-gray-100 relative">
                                {gameMode === 'VOICE' && <div className="absolute inset-0 rounded-full bg-rose-400 opacity-30 transition-transform duration-75 ease-out" style={{ transform: `scale(${1 + currentVolume})` }}></div>}
                                <div className="relative w-16 h-16 md:w-24 md:h-24 rounded-full bg-orange-500 flex items-center justify-center text-white font-black text-xl md:text-2xl shadow-inner z-10">
                                    {gameMode === 'VOICE' ? <MicOff size={32}/> : '...'}
                                </div>
                                <div className="absolute top-full mt-2 left-1/2 -translate-x-1/2 whitespace-nowrap bg-orange-100 text-orange-600 text-xs px-2 py-1 rounded font-bold">{gameMode === 'VOICE' ? '保持安静...' : '等待信号'}</div>
                            </div>
                        )}
                        {gameState === 'GO' && (
                            <div className="animate-bounce">
                                <div className={`w-24 h-24 md:w-32 md:h-32 rounded-full flex items-center justify-center text-white font-black text-3xl md:text-5xl shadow-2xl ring-8 ${gameMode === 'VOICE' ? 'bg-rose-500 ring-rose-200' : 'bg-green-500 ring-green-200'}`}>{gameMode === 'VOICE' ? '喊!' : 'GO!'}</div>
                            </div>
                        )}
                        {gameState === 'ENDED' && (
                            <div className="flex flex-col items-center bg-white p-4 rounded-2xl shadow-2xl border border-gray-100 animate-pop-in pointer-events-auto">
                                <div className={`text-2xl md:text-3xl font-black mb-1 ${winner === 'p1' ? 'text-rose-600' : 'text-sky-600'}`}>{winner === 'p1' ? '红方胜' : '蓝方胜'}</div>
                                {winReason === 'REACTION' && <div className="text-xl font-mono font-bold text-gray-700 bg-gray-100 px-3 py-1 rounded-lg">{reactionTime} ms</div>}
                                {detectedFreq > 0 && gameMode === 'VOICE' && <div className="text-xs text-gray-400 mt-1">检测频率: {detectedFreq}Hz</div>}
                                {winReason === 'FALSE_START' && <div className="text-red-500 font-bold text-sm">对方抢跑犯规</div>}
                                {isReplaying ? (
                                    <div className="mt-2 text-xs font-bold text-yellow-600 bg-yellow-100 px-3 py-1 rounded-full flex items-center gap-1 animate-pulse border border-yellow-200"><Volume2 size={12} /> 高光回放中</div>
                                ) : (
                                    gameMode === 'VOICE' && lastRecordingSize > 0 && <div className="mt-1 text-[10px] text-gray-400 border border-gray-200 rounded px-1">录音: {(lastRecordingSize/1024).toFixed(1)} KB</div>
                                )}
                            </div>
                        )}
                    </div>
                )}

                <PlayerZone id="p1" label="P1 红方" subLabel="高音区" keyLabel="键盘 'A'" colorClass="bg-rose-50" />
                <div className="absolute inset-0 pointer-events-none z-10 flex md:flex-row flex-col"><div className="md:w-1/2 w-full h-1/2 md:h-full border-b md:border-b-0 md:border-r border-gray-200/50"></div></div>
                <PlayerZone id="p2" label="P2 蓝方" subLabel="低音区" keyLabel="键盘 'L'" colorClass="bg-sky-50" />
                
                {gameState === 'ENDED' && !isReplaying && gameHistory.length > 0 && !isSavingAudio && gameMode === 'VOICE' && (
                     <div className="absolute bottom-8 left-1/2 transform -translate-x-1/2 z-30 pointer-events-auto">
                        <button onClick={startReplay} className={`flex items-center gap-2 px-5 py-2 backdrop-blur border text-white rounded-full text-sm font-bold shadow-lg active:scale-95 transition-all bg-rose-500/90 border-rose-400 hover:bg-rose-600`}>
                            <Volume2 size={16} /> 高光时刻
                        </button>
                     </div>
                )}
            </div>
        </div>
    );
}