const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const status = document.getElementById('status');

let socket;
let audioContext;
let recorderProcessor;
let mediaStream;

startBtn.onclick = async () => {
    startBtn.disabled = true;
    status.textContent = "Connecting...";

    // Connect to WebSocket
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${protocol}//${location.host}`);

    socket.onopen = async () => {
        status.textContent = "Connected. Starting Audio...";
        try {
            await startAudio();
            stopBtn.disabled = false;
        } catch (e) {
            console.error(e);
            status.textContent = "Error accessing microphone";
            socket.close();
            startBtn.disabled = false;
        }
    };

    socket.onmessage = async (event) => {
        const data = JSON.parse(event.data);
        if (data.audio) {
            playAudio(data.audio);
        }
        if (data.interrupted) {
            console.log("Interrupted");
            nextStartTime = audioContext ? audioContext.currentTime : 0;
        }
    };

    socket.onclose = () => {
        status.textContent = "Disconnected";
        stopBtn.disabled = true;
        startBtn.disabled = false;
        stopAudio();
    };

    socket.onerror = (e) => {
        console.error(e);
        status.textContent = "Error";
    };
};

stopBtn.onclick = () => {
    if (socket) socket.close();
};

// Playback Logic
let nextStartTime = 0;

function playAudio(base64Data) {
    if (!audioContext) return;

    const binaryString = atob(base64Data);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    const pcmData = new Int16Array(bytes.buffer);

    // Setup AudioBufferSource
    // Gemini Output -> 24kHz usually.
    // If our context is 24kHz, perfect. If not, the browser resamples.

    const float32Data = new Float32Array(pcmData.length);
    for (let i = 0; i < pcmData.length; i++) {
        float32Data[i] = pcmData[i] / 32768.0;
    }

    const buffer = audioContext.createBuffer(1, float32Data.length, 24000);
    buffer.getChannelData(0).set(float32Data);

    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);

    const now = audioContext.currentTime;
    const start = Math.max(now, nextStartTime);
    source.start(start);
    nextStartTime = start + buffer.duration;
}

// Recording Logic
async function startAudio() {
    // We prefer 16kHz for input to match Gemini requirement
    // but we need a context. 
    // If we use one context for both, let's try to set it to 24kHz to match output,
    // and downsample input? Or 48k standard.
    // Let's rely on getUserMedia to get close to 16k if possible, or handle resampling.

    // Using a standard context and resampling is safer.
    audioContext = new (window.AudioContext || window.webkitAudioContext)();

    mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
            sampleRate: 16000,
            channelCount: 1,
            echoCancellation: true
        }
    });

    const inputSampleRate = mediaStream.getAudioTracks()[0].getSettings().sampleRate || audioContext.sampleRate;
    console.log("Input Sample Rate:", inputSampleRate);

    const source = audioContext.createMediaStreamSource(mediaStream);

    // ScriptProcessor (Legacy but works everywhere for simple PCM access)
    // Buffer size 2048
    recorderProcessor = audioContext.createScriptProcessor(2048, 1, 1);

    recorderProcessor.onaudioprocess = (e) => {
        if (!socket || socket.readyState !== WebSocket.OPEN) return;

        const inputData = e.inputBuffer.getChannelData(0);

        // Simple downsampling if needed (e.g. 48k -> 16k)
        // For now, let's just send the data we get, converting to Int16.
        // NOTE: If sample rate is not 16k, this will sound off-pitch on server unless resampled.
        // Gemini REQUIRES 16k.

        // Naive decimation if rate is 48k (factor of 3) or 44.1k (harder)
        // Let's implemented a basic resampler or just trust getUserMedia for this prototype
        // If the context is 48000, and we want 16000, we take every 3rd sample.

        let pcmData;

        if (inputSampleRate === 48000) {
            // Downsample 48 -> 16 (1/3)
            const downsampledLength = Math.floor(inputData.length / 3);
            pcmData = new Int16Array(downsampledLength);
            for (let i = 0; i < downsampledLength; i++) {
                const val = inputData[i * 3];
                pcmData[i] = Math.max(-1, Math.min(1, val)) * 32767;
            }
        } else {
            // Pass through (Warning: if 44.1k, it will be wrong speed)
            pcmData = new Int16Array(inputData.length);
            for (let i = 0; i < inputData.length; i++) {
                pcmData[i] = Math.max(-1, Math.min(1, inputData[i])) * 32767;
            }
        }

        socket.send(pcmData.buffer);
    };

    source.connect(recorderProcessor);
    recorderProcessor.connect(audioContext.destination);
}

function stopAudio() {
    if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
    }
    if (recorderProcessor) {
        recorderProcessor.disconnect();
        recorderProcessor = null;
    }
    if (audioContext) {
        audioContext.close();
        audioContext = null;
    }
}
