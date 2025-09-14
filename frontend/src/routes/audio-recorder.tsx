import { createRoute } from '@tanstack/react-router'
import { useState, useRef, useEffect } from 'react'
import { Mic, MicOff, Play, Pause, Square, Download, Trash2 } from 'lucide-react'

import type { RootRoute } from '@tanstack/react-router'

interface AudioRecording {
  id: string
  name: string
  blob: Blob
  timestamp: Date
  duration: number
}

interface AudioDevice {
  deviceId: string
  label: string
}

function AudioRecorderPage() {
  const [isRecording, setIsRecording] = useState(false)
  const [recordings, setRecordings] = useState<AudioRecording[]>([])
  const [audioDevices, setAudioDevices] = useState<AudioDevice[]>([])
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('')
  const [currentPlayingId, setCurrentPlayingId] = useState<string | null>(null)
  const [recordingDuration, setRecordingDuration] = useState(0)
  const [permissionGranted, setPermissionGranted] = useState<boolean>(false)
  const [permissionError, setPermissionError] = useState<string>('')
  
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const recordingStartTimeRef = useRef<number>(0)
  const durationIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const audioElementsRef = useRef<{ [key: string]: HTMLAudioElement }>({})

  useEffect(() => {
    loadRecordingsFromIndexedDB()
    requestPermissionsAndGetDevices()
  }, [])

  const requestPermissionsAndGetDevices = async () => {
    try {
      // Request microphone permission first
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      setPermissionGranted(true)
      setPermissionError('')
      
      // Stop the stream immediately as we only needed it for permission
      stream.getTracks().forEach(track => track.stop())
      
      // Now get the devices with proper labels
      await getAudioDevices()
    } catch (error) {
      console.error('Error requesting permissions:', error)
      setPermissionGranted(false)
      setPermissionError('Microphone permission denied. Please allow microphone access to use this feature.')
      
      // Try to get devices anyway (might work on some browsers without labels)
      await getAudioDevices()
    }
  }

  const convertToMono = async (audioBlob: Blob): Promise<Blob> => {
    try {
      const audioContext = new AudioContext()
      const arrayBuffer = await audioBlob.arrayBuffer()
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer)
      
      // If already mono, return as-is
      if (audioBuffer.numberOfChannels === 1) {
        return audioBlob
      }
      
      // Convert stereo to mono by averaging channels
      const monoBuffer = audioContext.createBuffer(
        1, // mono
        audioBuffer.length,
        audioBuffer.sampleRate
      )
      
      const monoData = monoBuffer.getChannelData(0)
      
      if (audioBuffer.numberOfChannels === 2) {
        const leftChannel = audioBuffer.getChannelData(0)
        const rightChannel = audioBuffer.getChannelData(1)
        
        // Average the two channels
        for (let i = 0; i < audioBuffer.length; i++) {
          monoData[i] = (leftChannel[i] + rightChannel[i]) / 2
        }
      } else {
        // More than 2 channels - mix them all
        const channels = []
        for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
          channels.push(audioBuffer.getChannelData(ch))
        }
        
        for (let i = 0; i < audioBuffer.length; i++) {
          let sum = 0
          for (const channel of channels) {
            sum += channel[i]
          }
          monoData[i] = sum / channels.length
        }
      }
      
      // Convert back to blob using MediaRecorder
      const offlineContext = new OfflineAudioContext(1, audioBuffer.length, audioBuffer.sampleRate)
      const source = offlineContext.createBufferSource()
      source.buffer = monoBuffer
      source.connect(offlineContext.destination)
      source.start()
      
      const renderedBuffer = await offlineContext.startRendering()
      
      // Create a new MediaRecorder to encode as WebM
      const canvas = document.createElement('canvas')
      const mediaStream = new MediaStream()
      
      // Create an audio stream from the mono buffer
      const dest = audioContext.createMediaStreamDestination()
      const sourceNode = audioContext.createBufferSource()
      sourceNode.buffer = renderedBuffer
      sourceNode.connect(dest)
      
      mediaStream.addTrack(dest.stream.getAudioTracks()[0])
      
      return new Promise((resolve) => {
        const chunks: Blob[] = []
        const recorder = new MediaRecorder(mediaStream)
        
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunks.push(e.data)
        }
        
        recorder.onstop = () => {
          const blob = new Blob(chunks, { type: 'audio/webm' })
          resolve(blob)
          audioContext.close()
        }
        
        sourceNode.start()
        recorder.start()
        
        // Stop after the audio finishes
        setTimeout(() => {
          recorder.stop()
          sourceNode.stop()
        }, (renderedBuffer.duration * 1000) + 100)
      })
      
    } catch (error) {
      console.error('Error converting to mono:', error)
      return audioBlob // Return original if conversion fails
    }
  }

  const getAudioDevices = async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      const audioInputDevices = devices
        .filter(device => device.kind === 'audioinput')
        .map((device, index) => ({
          deviceId: device.deviceId,
          label: device.label || `Microphone ${index + 1} (${device.deviceId ? device.deviceId.slice(0, 8) + '...' : 'Unknown'})`
        }))
      
      console.log('Found audio devices:', audioInputDevices)
      setAudioDevices(audioInputDevices)
      
      if (audioInputDevices.length > 0 && !selectedDeviceId) {
        setSelectedDeviceId(audioInputDevices[0].deviceId)
      }
      
      // Add a default device if none found
      if (audioInputDevices.length === 0) {
        const defaultDevice = { deviceId: '', label: 'Default Microphone' }
        setAudioDevices([defaultDevice])
        setSelectedDeviceId('')
      }
    } catch (error) {
      console.error('Error getting audio devices:', error)
      // Fallback to default device
      const defaultDevice = { deviceId: '', label: 'Default Microphone' }
      setAudioDevices([defaultDevice])
      setSelectedDeviceId('')
    }
  }

  const openIndexedDB = (): Promise<IDBDatabase> => {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('AudioRecorderDB', 1)
      
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result)
      
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result
        if (!db.objectStoreNames.contains('recordings')) {
          db.createObjectStore('recordings', { keyPath: 'id' })
        }
      }
    })
  }

  const saveRecordingToIndexedDB = async (recording: AudioRecording) => {
    try {
      const db = await openIndexedDB()
      const transaction = db.transaction(['recordings'], 'readwrite')
      const store = transaction.objectStore('recordings')
      await store.add(recording)
    } catch (error) {
      console.error('Error saving recording to IndexedDB:', error)
    }
  }

  const loadRecordingsFromIndexedDB = async () => {
    try {
      const db = await openIndexedDB()
      const transaction = db.transaction(['recordings'], 'readonly')
      const store = transaction.objectStore('recordings')
      const request = store.getAll()
      
      request.onsuccess = () => {
        const savedRecordings = request.result.map((recording: any) => ({
          ...recording,
          timestamp: new Date(recording.timestamp)
        }))
        setRecordings(savedRecordings)
      }
    } catch (error) {
      console.error('Error loading recordings from IndexedDB:', error)
    }
  }

  const deleteRecordingFromIndexedDB = async (id: string) => {
    try {
      const db = await openIndexedDB()
      const transaction = db.transaction(['recordings'], 'readwrite')
      const store = transaction.objectStore('recordings')
      await store.delete(id)
    } catch (error) {
      console.error('Error deleting recording from IndexedDB:', error)
    }
  }

  const startRecording = async () => {
    try {
      console.log('Attempting to record from device:', selectedDeviceId)
      
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: selectedDeviceId 
          ? { 
              deviceId: { exact: selectedDeviceId },
              sampleRate: 44100,
              channelCount: 1,
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false
            }
          : {
              sampleRate: 44100,
              channelCount: 1,
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false
            }
      })

      console.log('Stream obtained:', stream)
      console.log('Audio tracks:', stream.getAudioTracks())
      
      // Check if we have audio tracks
      if (stream.getAudioTracks().length === 0) {
        throw new Error('No audio tracks found in stream')
      }

      const audioTrack = stream.getAudioTracks()[0]
      console.log('Audio track settings:', audioTrack.getSettings())
      console.log('Audio track constraints:', audioTrack.getConstraints())

      const mediaRecorder = new MediaRecorder(stream)
      console.log('MediaRecorder created successfully')
      mediaRecorderRef.current = mediaRecorder
      audioChunksRef.current = []

      mediaRecorder.ondataavailable = (event) => {
        console.log('Data available:', event.data.size, 'bytes')
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data)
        }
      }

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' })
        const duration = Date.now() - recordingStartTimeRef.current
        
        // Convert stereo to mono using Web Audio API
        const monoBlob = await convertToMono(audioBlob)
        
        const newRecording: AudioRecording = {
          id: Date.now().toString(),
          name: `Recording ${new Date().toLocaleString()}`,
          blob: monoBlob,
          timestamp: new Date(),
          duration: Math.floor(duration / 1000)
        }

        setRecordings(prev => [newRecording, ...prev])
        saveRecordingToIndexedDB(newRecording)
        
        stream.getTracks().forEach(track => track.stop())
      }

      recordingStartTimeRef.current = Date.now()
      setRecordingDuration(0)
      
      durationIntervalRef.current = setInterval(() => {
        setRecordingDuration(Math.floor((Date.now() - recordingStartTimeRef.current) / 1000))
      }, 1000)

      mediaRecorder.start()
      setIsRecording(true)
    } catch (error) {
      console.error('Error starting recording:', error)
      alert('Error starting recording. Please check your microphone permissions.')
    }
  }

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop()
      setIsRecording(false)
      
      if (durationIntervalRef.current) {
        clearInterval(durationIntervalRef.current)
        durationIntervalRef.current = null
      }
    }
  }

  const playRecording = (recording: AudioRecording) => {
    if (currentPlayingId === recording.id) {
      const audio = audioElementsRef.current[recording.id]
      if (audio) {
        audio.pause()
        setCurrentPlayingId(null)
      }
      return
    }

    if (currentPlayingId) {
      const currentAudio = audioElementsRef.current[currentPlayingId]
      if (currentAudio) {
        currentAudio.pause()
      }
    }

    if (!audioElementsRef.current[recording.id]) {
      const audio = new Audio(URL.createObjectURL(recording.blob))
      audio.onended = () => setCurrentPlayingId(null)
      audioElementsRef.current[recording.id] = audio
    }

    const audio = audioElementsRef.current[recording.id]
    audio.play()
    setCurrentPlayingId(recording.id)
  }

  const downloadRecording = (recording: AudioRecording) => {
    const url = URL.createObjectURL(recording.blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${recording.name}.webm`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const deleteRecording = async (id: string) => {
    if (currentPlayingId === id) {
      const audio = audioElementsRef.current[id]
      if (audio) {
        audio.pause()
        setCurrentPlayingId(null)
      }
    }
    
    if (audioElementsRef.current[id]) {
      delete audioElementsRef.current[id]
    }

    setRecordings(prev => prev.filter(recording => recording.id !== id))
    await deleteRecordingFromIndexedDB(id)
  }

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-100 to-slate-200 p-4">
      <div className="max-w-4xl mx-auto">
        <div className="bg-white rounded-xl shadow-lg p-8 mb-6">
          <h1 className="text-3xl font-bold text-gray-800 mb-6">Audio Recorder</h1>
          
          {/* Permission Error */}
          {permissionError && (
            <div className="mb-6 p-4 bg-red-100 border border-red-300 rounded-lg">
              <div className="flex items-center space-x-2 mb-2">
                <MicOff className="text-red-500" size={20} />
                <h3 className="font-medium text-red-800">Microphone Access Required</h3>
              </div>
              <p className="text-red-700 mb-3">{permissionError}</p>
              <button
                onClick={requestPermissionsAndGetDevices}
                className="bg-red-500 hover:bg-red-600 text-white px-4 py-2 rounded-lg font-medium transition-colors"
              >
                Grant Microphone Access
              </button>
            </div>
          )}

          {/* Audio Source Selection */}
          <div className="mb-6">
            <label htmlFor="audio-device" className="block text-sm font-medium text-gray-700 mb-2">
              Select Audio Source
              {!permissionGranted && (
                <span className="text-sm text-gray-500 ml-2">(Grant permission to see device names)</span>
              )}
            </label>
            <div className="flex space-x-2">
              <select
                id="audio-device"
                value={selectedDeviceId}
                onChange={(e) => setSelectedDeviceId(e.target.value)}
                className="flex-1 p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                disabled={isRecording}
              >
                {audioDevices.map((device) => (
                  <option key={device.deviceId || 'default'} value={device.deviceId}>
                    {device.label}
                  </option>
                ))}
              </select>
              <button
                onClick={getAudioDevices}
                className="px-4 py-2 bg-gray-200 hover:bg-gray-300 text-gray-700 rounded-lg transition-colors"
                title="Refresh devices"
              >
                🔄
              </button>
            </div>
          </div>

          {/* Recording Controls */}
          <div className="flex items-center justify-center space-x-4 mb-6">
            {!isRecording ? (
              <button
                onClick={startRecording}
                className="flex items-center space-x-2 bg-red-500 hover:bg-red-600 text-white px-6 py-3 rounded-lg font-medium transition-colors"
                disabled={!selectedDeviceId}
              >
                <Mic size={20} />
                <span>Start Recording</span>
              </button>
            ) : (
              <button
                onClick={stopRecording}
                className="flex items-center space-x-2 bg-gray-500 hover:bg-gray-600 text-white px-6 py-3 rounded-lg font-medium transition-colors"
              >
                <Square size={20} />
                <span>Stop Recording</span>
              </button>
            )}
            
            {isRecording && (
              <div className="flex items-center space-x-2 text-red-500">
                <div className="w-3 h-3 bg-red-500 rounded-full animate-pulse"></div>
                <span className="font-mono text-lg">{formatDuration(recordingDuration)}</span>
              </div>
            )}
          </div>
        </div>

        {/* Recordings List */}
        <div className="bg-white rounded-xl shadow-lg p-8">
          <h2 className="text-2xl font-bold text-gray-800 mb-6">Recorded Audio</h2>
          
          {recordings.length === 0 ? (
            <div className="text-center py-12 text-gray-500">
              <MicOff size={48} className="mx-auto mb-4 opacity-50" />
              <p>No recordings yet. Start recording to see your audio files here.</p>
            </div>
          ) : (
            <div className="space-y-4">
              {recordings.map((recording) => (
                <div
                  key={recording.id}
                  className="flex items-center justify-between p-4 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  <div className="flex-1">
                    <h3 className="font-medium text-gray-800">{recording.name}</h3>
                    <p className="text-sm text-gray-500">
                      {recording.timestamp.toLocaleString()} • Duration: {formatDuration(recording.duration)}
                    </p>
                  </div>
                  
                  <div className="flex items-center space-x-2">
                    <button
                      onClick={() => playRecording(recording)}
                      className="p-2 text-blue-500 hover:bg-blue-100 rounded-lg transition-colors"
                      title={currentPlayingId === recording.id ? "Pause" : "Play"}
                    >
                      {currentPlayingId === recording.id ? <Pause size={20} /> : <Play size={20} />}
                    </button>
                    
                    <button
                      onClick={() => downloadRecording(recording)}
                      className="p-2 text-green-500 hover:bg-green-100 rounded-lg transition-colors"
                      title="Download"
                    >
                      <Download size={20} />
                    </button>
                    
                    <button
                      onClick={() => deleteRecording(recording.id)}
                      className="p-2 text-red-500 hover:bg-red-100 rounded-lg transition-colors"
                      title="Delete"
                    >
                      <Trash2 size={20} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default (parentRoute: RootRoute) =>
  createRoute({
    path: '/audio-recorder',
    component: AudioRecorderPage,
    getParentRoute: () => parentRoute,
  })