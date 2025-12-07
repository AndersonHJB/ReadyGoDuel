import React, { useState, useEffect, useRef } from 'react';
import { Hand, RotateCcw, Play, AlertTriangle, Trophy, Volume2, VolumeX, Mic, MicOff, User, Activity, RefreshCw, BarChart3, Loader2, Music } from 'lucide-react';

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
    blobSize?: number; // 新增：记录大小用于调试
}

// --- 音效管理器 ---
const playSound = (type: 'start' | 'go' | 'false' | 'win' | 'test', mode: GameMode) => {
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
        } else if (type === 'test') { // 测试音
            oscillator.type = 'triangle';
            oscillator.frequency.setValueAtTime(440, now);
            gainNode.gain.setValueAtTime(0.5, now);
            gainNode.gain.linearRampToValueAtTime(0.01, now + 0.5);
            oscillator.start(now);
            oscillator.stop(now + 0.5);
        }
    } catch (e) {
        console.error("Audio playback failed", e);
    }
};

// --- 音高检测 (简化版自相关) ---
const detectPitch = (buffer: Float32Array, sampleRate: number): number => {
    const SIZE = buffer.length;
    let rms = 0;
    for (let i = 0; i < SIZE; i++) rms += buffer[i] * buffer[i];
    rms = Math.sqrt(rms / SIZE);
    if (rms < 0.01) return -1; // 噪音门限

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
    
    // Debug & 预检状态
    const [debugInfo, setDebugInfo] = useState({ state: 'init', mic: 'waiting', vol: 0 });
    const [isMicInitialized, setIsMicInitialized] = useState(false);
    const [isSavingAudio, setIsSavingAudio] = useState(false);
    const [lastRecordingSize, setLastRecordingSize] = useState<number>(0); // 调试显示用

    // 回放
    const [gameHistory, setGameHistory] = useState<GameLog[]>([]);
    const [isReplaying, setIsReplaying] = useState(false);
    
    // Refs - 核心对象
    const timerRef = useRef<NodeJS.Timeout | null>(null);
    const startTimeRef = useRef<number>(0);
    const signalTimeRef = useRef<number>(0);
    const stateRef = useRef<GameState>('IDLE');
    const historyRecorder = useRef<GameLog[]>([]);
    
    // Refs - 音频对象 (持久化)
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const audioChunksRef = useRef<Blob[]>([]);
    const audioContextRef = useRef<AudioContext | null>(null);
    const analyserRef = useRef<AnalyserNode | null>(null);
    const micStreamRef = useRef<MediaStream | null>(null);
    const animationFrameRef = useRef<number | null>(null);
    const recordingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const replaySourceRef = useRef<AudioBufferSourceNode | null>(null);

    useEffect(() => { stateRef.current = gameState; }, [gameState]);

    // 清理
    useEffect(() => {
        return () => { stopAudioResources(); };
    }, []);

    const stopAudioResources = () => {
        if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
            mediaRecorderRef.current.stop();
        }
        if (replaySourceRef.current) {
            try { replaySourceRef.current.stop(); } catch(e) {}
        }
        if (recordingTimeoutRef.current) clearTimeout(recordingTimeoutRef.current);
    };

    // --- 音频引擎核心 ---
    const initAudioEngine = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            micStreamRef.current = stream;

            const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
            const ctx = new AudioContextClass();
            audioContextRef.current = ctx;
            await ctx.resume();

            const source = ctx.createMediaStreamSource(stream);
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 2048;
            analyserRef.current = analyser;

            const muteGain = ctx.createGain();
            muteGain.gain.value = 0.001; 
            source.connect(analyser);
            analyser.connect(muteGain);
            muteGain.connect(ctx.destination);

            setIsMicInitialized(true);
            setDebugInfo(prev => ({ ...prev, state: ctx.state, mic: 'Active' }));

            startMonitoringLoop();
            
            return true;
        } catch (err) {
            console.error("Audio Init Failed", err);
            setDebugInfo(prev => ({ ...prev, mic: 'Error', state: 'failed' }));
            alert("麦克风启动失败。请确保允许权限，且没有其他应用占用麦克风。");
            return false;
        }
    };

    const startMonitoringLoop = () => {
        if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
        
        const loop = () => {
            if (!analyserRef.current || !audioContextRef.current) return;
            
            if (audioContextRef.current.state === 'suspended') {
                audioContextRef.current.resume();
            }

            const bufferLength = analyserRef.current.fftSize;
            const dataArray = new Float32Array(bufferLength);
            analyserRef.current.getFloatTimeDomainData(dataArray);

            let sum = 0;
            let hasSignal = false;
            for (let i = 0; i < bufferLength; i++) {
                const val = dataArray[i];
                sum += val * val;
                if (Math.abs(val) > 0.0001) hasSignal = true; 
            }
            
            if (!hasSignal) {
                const byteArray = new Uint8Array(bufferLength);
                analyserRef.current.getByteTimeDomainData(byteArray);
                sum = 0;
                for(let i=0; i<bufferLength; i++) {
                    const val = (byteArray[i] - 128) / 128.0;
                    sum += val * val;
                }
            }

            const rms = Math.sqrt(sum / bufferLength);
            const amplifiedVol = Math.min(rms * 15, 1.5); 
            setCurrentVolume(amplifiedVol);
            setDebugInfo(prev => ({ 
                ...prev, 
                vol: parseFloat(rms.toFixed(4)),
                state: audioContextRef.current?.state || 'unknown'
            }));

            // 游戏逻辑触发
            if (stateRef.current === 'WAITING' || stateRef.current === 'GO') {
                if (rms > 0.02) { 
                    handleVoiceTrigger(dataArray, audioContextRef.current.sampleRate);
                }
            }

            animationFrameRef.current = requestAnimationFrame(loop);
        };
        loop();
    };

    // --- 游戏流程 ---

    const handleVoiceTrigger = (buffer: Float32Array, sampleRate: number) => {
        if (stateRef.current === 'IDLE' || stateRef.current === 'ENDED') return;

        const pitch = detectPitch(buffer, sampleRate);
        setDetectedFreq(Math.round(pitch));

        let guessedWinner: Player = null;
        if (pitch > 0) {
            if (pitch > 200) guessedWinner = 'p1';
            else guessedWinner = 'p2';
        }
        
        handleAction(guessedWinner || 'p1', 'VOICE_TRIGGER');
    };

    const startGame = async () => {
        if (isReplaying || isSavingAudio) return;

        if (recordingTimeoutRef.current) clearTimeout(recordingTimeoutRef.current);

        if (gameMode === 'VOICE' && !isMicInitialized) {
            const success = await initAudioEngine();
            if (!success) return; 
        }

        setGameState('WAITING');
        setWinner(null);
        setWinReason(null);
        setReactionTime(0);
        setDetectedFreq(0);
        setIsSavingAudio(false);
        setLastRecordingSize(0);
        historyRecorder.current = [];
        
        if (soundEnabled) playSound('start', gameMode);

        const now = Date.now();
        startTimeRef.current = now;
        historyRecorder.current.push({ step: 'WAITING', timestamp: 0 });

        if (gameMode === 'VOICE' && micStreamRef.current) {
            startRecording();
        }

        const randomDelay = Math.floor(Math.random() * 4000) + 2000; 
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(triggerSignal, randomDelay);
    };

    const startRecording = () => {
        if (!micStreamRef.current) return;
        audioChunksRef.current = [];
        
        // --- 核心修复：不传任何 options，让浏览器自己选择最佳格式 (兼容 iOS Safari) ---
        try {
            const recorder = new MediaRecorder(micStreamRef.current);
            recorder.ondataavailable = (e) => {
                // 确保数据非空才 push
                if (e.data && e.data.size > 0) {
                    audioChunksRef.current.push(e.data);
                }
            };
            recorder.start();
            mediaRecorderRef.current = recorder;
            console.log("Recording started with default mimeType:", recorder.mimeType);
        } catch (e) {
            console.error("Default recorder failed, trying fallback", e);
            // Fallback: 尝试显式指定
            try {
                const mime = MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : 'audio/webm';
                const recorder = new MediaRecorder(micStreamRef.current, { mimeType: mime });
                recorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
                recorder.start();
                mediaRecorderRef.current = recorder;
            } catch (e2) {
                console.error("Fallback recorder failed", e2);
            }
        }
    };

    const triggerSignal = () => {
        const now = Date.now();
        signalTimeRef.current = now;
        setGameState('GO');
        if (soundEnabled) playSound('go', gameMode);
        historyRecorder.current.push({ step: 'GO', timestamp: now - startTimeRef.current });
    };

    const handleAction = (player: 'p1' | 'p2', triggerType: 'TOUCH' | 'VOICE_TRIGGER' = 'TOUCH') => {
        if (stateRef.current === 'IDLE' || stateRef.current === 'ENDED' || isReplaying) return;

        const now = Date.now();
        
        let finalWinner = player;
        let finalReason: WinReason = 'REACTION';
        if (stateRef.current === 'WAITING') {
            finalWinner = player === 'p1' ? 'p2' : 'p1';
            finalReason = 'FALSE_START';
        } else if (stateRef.current === 'GO') {
            finalReason = 'REACTION';
        }
        const timeDiff = stateRef.current === 'GO' ? now - signalTimeRef.current : 0;

        endGame(finalWinner, finalReason, timeDiff);
        if (soundEnabled) playSound(finalReason === 'FALSE_START' ? 'false' : 'win', gameMode);

        const logEntry: GameLog = {
            step: 'END',
            timestamp: now - startTimeRef.current,
            winner: finalWinner,
            winReason: finalReason,
            reactionTime: timeDiff,
        };
        historyRecorder.current.push(logEntry);
        setGameHistory([...historyRecorder.current]);

        if (gameMode === 'VOICE') {
            setIsSavingAudio(true);
            // 录制 1.5 秒的“尾音”
            recordingTimeoutRef.current = setTimeout(() => {
                stopRecordingAndSave(logEntry);
            }, 1500); 
        } else {
             stopRecordingAndSave(logEntry); 
        }
    };

    const stopRecordingAndSave = (logEntry: GameLog) => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
            mediaRecorderRef.current.requestData();
            mediaRecorderRef.current.stop();
            
            // 等待数据收集
            setTimeout(() => {
                const chunks = audioChunksRef.current;
                const totalSize = chunks.reduce((acc, chunk) => acc + chunk.size, 0);
                setLastRecordingSize(totalSize); // 更新 UI 用于调试

                if (totalSize > 0) {
                    // 使用 recorder 的实际 mimeType，而不是猜测
                    const mimeType = mediaRecorderRef.current?.mimeType || 'audio/webm'; 
                    const audioBlob = new Blob(chunks, { type: mimeType });
                    logEntry.audioBlob = audioBlob;
                    logEntry.blobSize = totalSize;
                    
                    setGameHistory([...historyRecorder.current]);
                } else {
                    console.warn("Recording size is 0 bytes!");
                }
                setIsSavingAudio(false);
            }, 100);
        } else {
            setIsSavingAudio(false);
        }
    };

    const endGame = (winnerPlayer: Player, reason: WinReason, time: number) => {
        setGameState('ENDED');
        setWinner(winnerPlayer);
        setWinReason(reason);
        setReactionTime(time);
    };

    const playBlobWithGain = async (blob: Blob) => {
        try {
            // 每次回放都检查/新建 Context，防止旧 Context 状态异常
            const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
            const ctx = new AudioContextClass(); // 新建更稳妥
            audioContextRef.current = ctx; // 更新引用
            
            const arrayBuffer = await blob.arrayBuffer();
            const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

            const source = ctx.createBufferSource();
            source.buffer = audioBuffer;

            const gainNode = ctx.createGain();
            gainNode.gain.value = 8.0; // 放大音量

            source.connect(gainNode);
            gainNode.connect(ctx.destination);

            replaySourceRef.current = source;
            source.start(0);
        } catch (e) {
            console.error("Playback failed:", e);
            alert("回放失败：可能是录音格式不兼容或数据损坏。");
        }
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

        if (!waitingFrame || !endFrame) { setIsReplaying(false); return; }

        if (endFrame.audioBlob) {
            playBlobWithGain(endFrame.audioBlob);
        }

        setGameState('WAITING');
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
            if (replaySourceRef.current) {
                try { replaySourceRef.current.stop(); } catch(e) {}
                replaySourceRef.current = null;
            }
        }, endDelay);
    };

    // 键盘监听
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.repeat) return;
            if (gameMode === 'VOICE' && gameState !== 'IDLE') return; 
            if (e.key.toLowerCase() === 'a') handleAction('p1');
            if (e.key.toLowerCase() === 'l') handleAction('p2');
            if (e.code === 'Space' && gameState === 'IDLE' && !isReplaying) startGame();
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [gameState, isReplaying, gameMode]);


    // --- 界面组件 ---
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

        return (
            <div 
                className={`flex-1 relative flex flex-col items-center justify-center transition-all duration-300 touch-manipulation select-none overflow-hidden ${bgColor}`}
                onPointerDown={(e) => {
                    if (gameMode === 'TOUCH') { 
                        e.preventDefault();
                        handleAction(id);
                    }
                }}
            >
                <div className={`flex flex-col items-center justify-center w-full h-full p-4 ${rotationClass}`}>
                    <div className={`transform transition-all duration-300 ${isWinner ? 'scale-125 -translate-y-4' : ''}`}>
                        {isLoser && winReason === 'FALSE_START' ? (
                             <div className="flex flex-col items-center text-red-500/80 font-bold animate-pulse">
                                <AlertTriangle size={80} />
                                <span className="text-2xl mt-2">抢跑!</span>
                            </div>
                        ) : (
                            <div className="relative">
                                {gameMode === 'VOICE' ? (
                                    <Mic size={isWinner ? 140 : 100} className={`${isWinner ? 'text-white' : 'text-gray-800/20'} transition-colors duration-300`} />
                                ) : (
                                    <Hand size={isWinner ? 140 : 100} strokeWidth={1.5} className={`${isWinner ? 'text-white fill-white/20' : 'text-gray-800/20'} transition-colors duration-300`} />
                                )}
                            </div>
                        )}
                    </div>
                    <div className={`mt-6 text-center z-10 ${isWinner ? 'text-white' : 'text-gray-600/60'}`}>
                        <h2 className="text-3xl font-black tracking-wider">{label}</h2>
                        {gameMode === 'VOICE' && subLabel && (
                            <p className={`text-sm font-bold mt-1 ${isWinner ? 'text-white/90' : 'text-gray-500'}`}>{subLabel}</p>
                        )}
                        <p className="text-sm font-medium mt-1 opacity-70 hidden md:block">{gameMode === 'VOICE' ? '喊出声音!' : keyLabel}</p>
                    </div>
                    {isWinner && (
                        <div className="absolute animate-bounce mt-32"><Trophy size={48} className="text-yellow-300 drop-shadow-md" fill="currentColor" /></div>
                    )}
                </div>
            </div>
        );
    };

    return (
        <div className="w-full h-screen flex flex-col bg-white overflow-hidden font-sans relative">
            
            {/* 简易头部 */}
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
                        <button onClick={startGame} className={`p-2 active:bg-indigo-700 text-white rounded-full shadow-sm transition-all ${isSavingAudio ? 'bg-gray-400 cursor-not-allowed' : 'bg-indigo-600'}`} disabled={isSavingAudio}>
                            {isSavingAudio ? <Loader2 size={18} className="animate-spin" /> : <RotateCcw size={18} />}
                        </button>
                    )}
                </div>
            </div>

            {/* IDLE 状态 (含麦克风测试) */}
            {gameState === 'IDLE' && !isReplaying && (
                <div className="absolute inset-0 z-40 bg-white/95 backdrop-blur-md flex flex-col items-center justify-center p-6 text-center animate-fade-in">
                    
                    {/* 模式切换 */}
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

                    {/* 声音模式下的麦克风预检 */}
                    {gameMode === 'VOICE' && (
                        <div className="mb-8 w-full max-w-xs bg-gray-50 p-4 rounded-xl border border-gray-200">
                            <div className="flex justify-between items-center mb-2 text-xs font-bold text-gray-500">
                                <span className="flex items-center gap-1"><BarChart3 size={12}/> 麦克风测试</span>
                                <span className={isMicInitialized ? "text-green-500" : "text-gray-400"}>
                                    {isMicInitialized ? "已连接" : "未启动"}
                                </span>
                            </div>
                            
                            {/* 音量条 */}
                            <div className="h-3 bg-gray-200 rounded-full overflow-hidden relative">
                                <div className="absolute left-0 top-0 bottom-0 bg-green-500 transition-all duration-75" style={{ width: `${Math.min(currentVolume * 100, 100)}%` }}></div>
                                <div className="absolute top-0 bottom-0 w-0.5 bg-red-400 left-[2%] z-10"></div> 
                            </div>
                            
                            <div className="mt-3 flex gap-2">
                                {!isMicInitialized ? (
                                    <button onClick={initAudioEngine} className="flex-1 py-2 bg-gray-800 text-white text-xs font-bold rounded hover:bg-black transition-colors">
                                        启动麦克风 (点击授权)
                                    </button>
                                ) : (
                                    <>
                                        <button onClick={() => initAudioEngine()} className="flex-1 py-2 bg-white border border-gray-300 text-gray-600 text-xs font-bold rounded hover:bg-gray-50 flex items-center justify-center gap-1">
                                            <RefreshCw size={10}/> 重置 Mic
                                        </button>
                                        <button onClick={() => playSound('test', 'VOICE')} className="flex-1 py-2 bg-white border border-gray-300 text-gray-600 text-xs font-bold rounded hover:bg-gray-50 flex items-center justify-center gap-1">
                                            <Music size={10}/> 播放测试音
                                        </button>
                                    </>
                                )}
                            </div>
                            <p className="text-[10px] text-gray-400 mt-2 text-left">
                                * 如果音量条动了但听不到"测试音"，请检查系统音量。
                            </p>
                        </div>
                    )}

                    <button 
                        onClick={startGame}
                        className={`w-full max-w-xs py-4 text-white text-lg font-bold rounded-xl shadow-xl transition-all flex items-center justify-center gap-2 active:scale-95
                            ${gameMode === 'VOICE' ? 'bg-rose-500 hover:bg-rose-600 shadow-rose-200' : 'bg-indigo-600 hover:bg-indigo-700 shadow-indigo-200'}`}
                    >
                        <Play size={24} fill="currentColor" />
                        立即开始
                    </button>
                </div>
            )}

            {/* 游戏主区域 */}
            <div className="flex-1 flex flex-col md:flex-row relative">
                
                {/* 信号区 */}
                {gameState !== 'IDLE' && (
                    <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 z-40 pointer-events-none flex flex-col items-center justify-center">
                        {gameState === 'WAITING' && (
                            <div className="bg-white p-2 rounded-full shadow-lg border-4 border-gray-100 relative">
                                {gameMode === 'VOICE' && (
                                    <div className="absolute inset-0 rounded-full bg-rose-400 opacity-30 transition-transform duration-75 ease-out" style={{ transform: `scale(${1 + currentVolume})` }}></div>
                                )}
                                <div className="relative w-16 h-16 md:w-24 md:h-24 rounded-full bg-orange-500 flex items-center justify-center text-white font-black text-xl md:text-2xl shadow-inner z-10">
                                    {gameMode === 'VOICE' ? <MicOff size={32}/> : '...'}
                                </div>
                                <div className="absolute top-full mt-2 left-1/2 -translate-x-1/2 whitespace-nowrap bg-orange-100 text-orange-600 text-xs px-2 py-1 rounded font-bold">
                                    {gameMode === 'VOICE' ? '保持安静...' : '等待信号'}
                                </div>
                            </div>
                        )}

                        {gameState === 'GO' && (
                            <div className="animate-bounce">
                                <div className={`w-24 h-24 md:w-32 md:h-32 rounded-full flex items-center justify-center text-white font-black text-3xl md:text-5xl shadow-2xl ring-8 ${gameMode === 'VOICE' ? 'bg-rose-500 ring-rose-200' : 'bg-green-500 ring-green-200'}`}>
                                    {gameMode === 'VOICE' ? '喊!' : 'GO!'}
                                </div>
                            </div>
                        )}

                        {gameState === 'ENDED' && (
                            <div className="flex flex-col items-center bg-white p-4 rounded-2xl shadow-2xl border border-gray-100 animate-pop-in pointer-events-auto">
                                <div className={`text-2xl md:text-3xl font-black mb-1 ${winner === 'p1' ? 'text-rose-600' : 'text-sky-600'}`}>
                                    {winner === 'p1' ? '红方胜' : '蓝方胜'}
                                    {gameMode === 'VOICE' && <span className="text-gray-400 text-sm font-normal ml-2">(系统猜测)</span>}
                                </div>
                                {winReason === 'REACTION' && <div className="text-xl font-mono font-bold text-gray-700 bg-gray-100 px-3 py-1 rounded-lg">{reactionTime} ms</div>}
                                {detectedFreq > 0 && gameMode === 'VOICE' && <div className="text-xs text-gray-400 mt-1">检测频率: {detectedFreq}Hz</div>}
                                {winReason === 'FALSE_START' && <div className="text-red-500 font-bold text-sm">{gameMode === 'VOICE' ? '提前发出声音!' : '对方抢跑犯规'}</div>}
                                
                                {/* 录音状态显示 */}
                                {gameMode === 'VOICE' && lastRecordingSize > 0 && (
                                    <div className="mt-1 text-[10px] text-gray-400 border border-gray-200 rounded px-1">
                                        录音大小: {(lastRecordingSize/1024).toFixed(1)} KB
                                    </div>
                                )}
                                {gameMode === 'VOICE' && lastRecordingSize === 0 && (
                                    <div className="mt-1 text-[10px] text-red-400">
                                        录音失败 (0 KB)
                                    </div>
                                )}

                                {isReplaying && <div className="mt-2 text-xs font-bold text-yellow-600 bg-yellow-100 px-2 py-0.5 rounded flex items-center gap-1"><Volume2 size={12} className="animate-pulse" /> 回放中...</div>}
                            </div>
                        )}
                    </div>
                )}

                <PlayerZone id="p1" label="P1 红方" subLabel={gameMode === 'VOICE' ? "高音区" : undefined} keyLabel="键盘 'A'" colorClass="bg-rose-50" />
                <div className="absolute inset-0 pointer-events-none z-10 flex md:flex-row flex-col">
                    <div className="md:w-1/2 w-full h-1/2 md:h-full border-b md:border-b-0 md:border-r border-gray-200/50"></div>
                </div>
                <PlayerZone id="p2" label="P2 蓝方" subLabel={gameMode === 'VOICE' ? "低音区" : undefined} keyLabel="键盘 'L'" colorClass="bg-sky-50" />
                
                {gameState === 'ENDED' && !isReplaying && gameHistory.length > 0 && (
                     <div className="absolute bottom-8 left-1/2 transform -translate-x-1/2 z-30 pointer-events-auto">
                        <button onClick={startReplay} className={`flex items-center gap-2 px-5 py-2 backdrop-blur border text-white rounded-full text-sm font-bold shadow-lg active:scale-95 transition-all ${gameMode === 'VOICE' ? 'bg-rose-500/90 border-rose-400 hover:bg-rose-600' : 'bg-white/90 border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
                            {gameMode === 'VOICE' ? <Volume2 size={16} /> : <RotateCcw size={14} />}
                            {gameMode === 'VOICE' ? '听声音回放' : '看回放'}
                        </button>
                     </div>
                )}
            </div>
        </div>
    );
}