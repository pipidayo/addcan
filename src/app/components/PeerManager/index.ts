// src/app/components/PeerManager/index.ts
import Peer, { MediaConnection, DataConnection, PeerJSOption } from 'peerjs'
import type { Socket } from 'socket.io-client'

// --- インターフェースと型定義 ---
type Message =
  | { type: 'USER_NAME'; payload: string }
  | { type: 'MUTE_STATUS'; payload: boolean }

export type InitPeerOptions = {
  roomCode: string
  socket: Socket
  onRemoteStream: (stream: MediaStream, peerId: string) => void
  onPeerOpen: (id: string) => void
  onLocalStream: (stream: MediaStream) => void
  onReceiveUserName: (peerId: string, name: string) => void
  onReceiveMuteStatus: (peerId: string, isMuted: boolean) => void
  onPeerDisconnect: (peerId: string) => void
  onSpeakingStatusChange?: (peerId: string, isSpeaking: boolean) => void
  onLocalScreenStreamUpdate?: (stream: MediaStream | null) => void
  onRemoteScreenStreamUpdate?: (stream: MediaStream, peerId: string) => void
}

type AudioAnalysisData = {
  context: AudioContext
  analyser: AnalyserNode
  source: MediaStreamAudioSourceNode
  lastIsSpeaking: boolean
  animationFrameId: number | null
  dataArray: Uint8Array
}

// ★ 音声ミキシング用リソースの型
type AudioMixingResources = {
  audioContext: AudioContext
  micSource: MediaStreamAudioSourceNode | null
  screenSource: MediaStreamAudioSourceNode | null
  destination: MediaStreamAudioDestinationNode
  mixedAudioTrack: MediaStreamTrack
}

// --- PeerManager クラス定義 ---
export class PeerManager {
  private peer: Peer | null = null
  private localStream: MediaStream | null = null
  private screenStream: MediaStream | null = null
  private screenShareTrackEndedListener: (() => void) | null = null
  private mediaConnections: { [id: string]: MediaConnection } = {}
  private dataConnections: { [id: string]: DataConnection } = {}
  private screenMediaConnections: { [id: string]: MediaConnection } = {}
  private options: InitPeerOptions | null = null
  private myName = ''
  private isMuted = false
  private audioAnalysisMap = new Map<string, AudioAnalysisData>()
  private readonly speakingThreshold = 10
  private audioMixingResources: AudioMixingResources | null = null
  private isCurrentlyScreenSharing: boolean = false
  private socket: Socket | null = null
  private roomCode: string | null = null
  private originalMicTrack: MediaStreamTrack | null = null
  private silentAudioTrack: MediaStreamTrack | null = null

  private isMessage(data: unknown): data is Message {
    if (typeof data !== 'object' || data === null) return false
    if (!('type' in data) || !('payload' in data)) return false
    const potentialMessage = data as { type: unknown; payload: unknown }
    switch (potentialMessage.type) {
      case 'USER_NAME':
        return typeof potentialMessage.payload === 'string'
      case 'MUTE_STATUS':
        return typeof potentialMessage.payload === 'boolean'
      default:
        return false
    }
  }

  private createDummyVideoTrack(): MediaStreamTrack {
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.fillStyle = 'black'
      ctx.fillRect(0, 0, 1, 1)
    }
    const stream = canvas.captureStream(1)
    const track = stream.getVideoTracks()[0]
    if (!track) {
      throw new Error('Failed to create dummy video track from canvas.')
    }
    track.enabled = false
    console.log(
      `[PeerManager instance ${this.peer?.id}] Created dummy video track: ${track.id}`
    )
    return track
  }

  private createSilentAudioTrack(): MediaStreamTrack {
    const audioContext = new AudioContext()
    const oscillator = audioContext.createOscillator()
    const gainNode = audioContext.createGain()

    oscillator.connect(gainNode) // Connect oscillator to gain node
    gainNode.gain.value = 0 // Ensure it's silent

    const destination = audioContext.createMediaStreamDestination()
    gainNode.connect(destination) // Connect gainNode output to the stream destination

    oscillator.start() // Start the oscillator to generate a signal (even if silent)

    const track = destination.stream.getAudioTracks()[0]
    track.enabled = false // Start disabled, will be enabled by sendMuteStatus if needed for localStream
    console.log(
      `[PeerManager instance ${this.peer?.id}] Created silent audio track: ${track.id}`
    )
    return track
  }

  private startAudioAnalysis(peerId: string, stream: MediaStream) {
    if (this.audioAnalysisMap.has(peerId)) return
    const audioTracks = stream.getAudioTracks()
    if (audioTracks.length === 0) return

    try {
      const context = new AudioContext()
      const source = context.createMediaStreamSource(stream)
      const analyser = context.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.3
      source.connect(analyser)
      const dataArray = new Uint8Array(analyser.frequencyBinCount)
      const analysisData: AudioAnalysisData = {
        context,
        analyser,
        source,
        lastIsSpeaking: false,
        animationFrameId: null,
        dataArray,
      }
      this.audioAnalysisMap.set(peerId, analysisData)

      const analyse = () => {
        const currentAnalysisData = this.audioAnalysisMap.get(peerId)
        if (
          !currentAnalysisData?.analyser ||
          !currentAnalysisData?.dataArray ||
          currentAnalysisData.context.state !== 'running'
        ) {
          if (currentAnalysisData?.animationFrameId)
            cancelAnimationFrame(currentAnalysisData.animationFrameId)
          return
        }
        currentAnalysisData.animationFrameId = requestAnimationFrame(analyse)
        currentAnalysisData.analyser.getByteFrequencyData(
          currentAnalysisData.dataArray
        )
        let sum = 0
        for (let i = 0; i < currentAnalysisData.dataArray.length; i++)
          sum += currentAnalysisData.dataArray[i]
        const average = sum / currentAnalysisData.dataArray.length
        const isSpeaking = average > this.speakingThreshold

        if (isSpeaking !== currentAnalysisData.lastIsSpeaking) {
          currentAnalysisData.lastIsSpeaking = isSpeaking
          this.options?.onSpeakingStatusChange?.(peerId, isSpeaking)
        }
      }
      analyse()
    } catch (error) {
      console.error(
        `[PeerManager instance ${this.peer?.id}] Error starting audio analysis for ${peerId}:`,
        error
      )
      this.stopAudioAnalysis(peerId)
    }
  }

  private stopAudioAnalysis(peerId: string) {
    const analysisData = this.audioAnalysisMap.get(peerId)
    if (analysisData) {
      if (analysisData.animationFrameId !== null)
        cancelAnimationFrame(analysisData.animationFrameId)
      try {
        analysisData.source?.disconnect()
      } catch {
        /* ignore */
      }
      analysisData.context
        ?.close()
        .catch((e) =>
          console.error(`Error closing AudioContext for ${peerId}:`, e)
        )
      this.audioAnalysisMap.delete(peerId)
      this.options?.onSpeakingStatusChange?.(peerId, false)
    }
  }

  private stopAllAudioAnalysis() {
    this.audioAnalysisMap.forEach((_, peerId) => this.stopAudioAnalysis(peerId))
    this.audioAnalysisMap.clear()
  }

  private setupDataConnectionHandlers(dataConn: DataConnection) {
    dataConn.on('open', () => {
      this.dataConnections[dataConn.peer] = dataConn
      this.sendMessage('USER_NAME', this.myName, dataConn.peer)
      this.sendMessage('MUTE_STATUS', this.isMuted, dataConn.peer)
    })
    dataConn.on('data', (data) => {
      this.handleDataMessage(data, dataConn.peer)
    })
    dataConn.on('close', () => this.handleDisconnect(dataConn.peer))
    dataConn.on('error', (err) => {
      console.error(
        `[PeerManager instance ${this.peer?.id}] Data connection error with ${dataConn.peer}:`,
        err
      )
      this.handleDisconnect(dataConn.peer)
    })
  }

  private handleDataMessage(data: unknown, peerId: string) {
    if (!this.isMessage(data)) {
      console.warn(
        `[PeerManager instance ${this.peer?.id}] Received invalid or unknown message format from ${peerId}:`,
        data
      )
      return
    }
    switch (data.type) {
      case 'USER_NAME':
        this.options?.onReceiveUserName?.(peerId, data.payload as string)
        break
      case 'MUTE_STATUS':
        this.options?.onReceiveMuteStatus?.(peerId, data.payload as boolean)
        break
    }
  }

  private async getLocalStream(deviceId?: string): Promise<MediaStream> {
    const currentAudioTrack = this.localStream?.getAudioTracks()[0]
    const currentVideoTrack = this.localStream?.getVideoTracks()[0]
    if (
      this.localStream &&
      currentVideoTrack &&
      (!deviceId || currentAudioTrack?.getSettings().deviceId === deviceId)
    ) {
      return this.localStream
    }

    this.localStream?.getTracks().forEach((track) => track.stop())
    this.localStream = null
    this.originalMicTrack = null

    try {
      const constraints: MediaStreamConstraints = {
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      }
      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      const dummyVideoTrack = this.createDummyVideoTrack()
      stream.addTrack(dummyVideoTrack)

      this.localStream = stream
      this.options?.onLocalStream(stream)
      const audioTrack = stream.getAudioTracks()[0]
      if (audioTrack) {
        this.originalMicTrack = audioTrack
        audioTrack.enabled = !this.isMuted
      }
      return stream
    } catch (err) {
      console.error(
        `[PeerManager instance ${this.peer?.id}] Failed to get local media stream:`,
        err
      )
      throw err
    }
  }

  private sendMessage(
    type: Message['type'],
    payload: Message['payload'],
    targetId?: string
  ) {
    if (!this.peer) return
    const message = { type, payload } as Message
    try {
      if (targetId) {
        if (this.dataConnections[targetId]?.open) {
          this.dataConnections[targetId].send(message)
        }
      } else {
        Object.values(this.dataConnections).forEach((conn) => {
          if (conn.open) conn.send(message)
        })
      }
    } catch (error) {
      console.error(
        `[PeerManager instance ${this.peer?.id}] Error sending message ${type}:`,
        error
      )
    }
  }

  private handleDisconnect(peerId: string) {
    if (!peerId) return
    this.stopAudioAnalysis(peerId)
    if (this.mediaConnections[peerId]) {
      this.mediaConnections[peerId].close()
      delete this.mediaConnections[peerId]
    }
    if (this.dataConnections[peerId]) {
      this.dataConnections[peerId].close()
      delete this.dataConnections[peerId]
    }
    if (this.screenMediaConnections[peerId]) {
      this.screenMediaConnections[peerId].close()
      delete this.screenMediaConnections[peerId]
    }
    this.options?.onPeerDisconnect(peerId)
  }

  public isScreenSharing(): boolean {
    return this.isCurrentlyScreenSharing
  }

  public async initPeer(
    options: InitPeerOptions,
    peerName: string,
    initialIsMuted: boolean = false
  ): Promise<string> {
    this.options = options
    this.myName = peerName
    this.isMuted = initialIsMuted
    this.socket = options.socket
    this.roomCode = options.roomCode

    if (this.peer) {
      this.peer.destroy()
      this.peer = null
    }

    return new Promise<string>(async (resolve, reject) => {
      try {
        const peerJsOptions: PeerJSOption = { debug: 2 }
        this.peer = new Peer(peerJsOptions)

        this.peer.on('open', async (id) => {
          if (!this.peer || this.peer.destroyed) return
          try {
            await this.getLocalStream()
            this.options?.onPeerOpen(id)
            resolve(id)
          } catch (streamError) {
            if (this.peer && !this.peer.destroyed) this.peer.destroy()
            this.peer = null
            reject(new Error('マイクへのアクセスに失敗しました。'))
          }
        })

        this.peer.on('connection', (dataConn) => {
          this.setupDataConnectionHandlers(dataConn)
        })

        this.peer.on('call', async (call) => {
          if (call.metadata?.type === 'screenShare') {
            call.answer()
            call.on('stream', (remoteScreenStream) => {
              this.options?.onRemoteScreenStreamUpdate?.(
                remoteScreenStream,
                call.peer
              )
            })
            call.on(
              'close',
              () => delete this.screenMediaConnections[call.peer]
            )
            call.on('error', (err) => {
              console.error(`Screen share call error with ${call.peer}:`, err)
              delete this.screenMediaConnections[call.peer]
            })
            this.screenMediaConnections[call.peer] = call
          } else {
            try {
              if (!this.localStream) await this.getLocalStream()
              if (!this.localStream) return

              call.answer(this.localStream)
              call.on('stream', (remoteStream) => {
                this.options?.onRemoteStream(remoteStream, call.peer)
                this.startAudioAnalysis(call.peer, remoteStream)
              })
              call.on('close', () => this.handleDisconnect(call.peer))
              call.on('error', (err) => {
                console.error(`Audio call error with ${call.peer}:`, err)
                this.handleDisconnect(call.peer)
              })
              this.mediaConnections[call.peer] = call
            } catch (err) {
              console.error(`Error answering audio call:`, err)
            }
          }
        })
        this.peer.on('disconnected', () => console.warn(`Peer disconnected.`))
        this.peer.on('close', () => (this.peer = null))
        this.peer.on('error', (err) => {
          console.error(`PeerJS error:`, err)
          if (err.type === 'peer-unavailable') {
            const unavailablePeerId = err.message.match(/peer\s(.*?)\s/)?.[1]
            if (unavailablePeerId) this.handleDisconnect(unavailablePeerId)
          }
          if (
            ['server-error', 'socket-error', 'socket-closed'].includes(err.type)
          ) {
            if (this.peer && !this.peer.destroyed) this.peer.destroy()
            this.peer = null
          }
        })
      } catch (err) {
        if (this.peer && !this.peer.destroyed) this.peer.destroy()
        this.peer = null
        reject(err)
      }
    })
  }

  private async connectData(targetId: string): Promise<DataConnection | null> {
    if (!this.peer) return null
    if (this.dataConnections[targetId]?.open)
      return this.dataConnections[targetId]

    return new Promise((resolve) => {
      try {
        if (!this.peer) {
          resolve(null)
          return
        }
        const dataConn = this.peer.connect(targetId)
        dataConn.on('open', () => {
          this.setupDataConnectionHandlers(dataConn)
          resolve(dataConn)
        })
        dataConn.on('error', (err) => {
          delete this.dataConnections[targetId]
          resolve(null)
        })
      } catch (error) {
        resolve(null)
      }
    })
  }

  public async callPeer(targetId: string) {
    if (!this.peer || !this.options || this.mediaConnections[targetId]) return

    try {
      await this.connectData(targetId)
      if (!this.localStream) await this.getLocalStream()
      if (!this.peer || !this.localStream) return

      const call = this.peer.call(targetId, this.localStream)
      call.on('close', () => this.handleDisconnect(targetId))
      call.on('error', (err) => this.handleDisconnect(targetId))
      this.mediaConnections[targetId] = call
    } catch (err) {
      this.handleDisconnect(targetId)
    }
  }

  public sendUserName(name: string) {
    this.myName = name
    this.sendMessage('USER_NAME', name)
  }

  public async sendMuteStatus(muted: boolean) {
    this.isMuted = muted
    let trackToUseForSend: MediaStreamTrack | null = null

    if (this.isMuted) {
      trackToUseForSend = null // Mute by sending null track
      console.log(
        `[PeerManager sendMuteStatus] Muting: Replacing tracks with null.`
      )
    } else {
      trackToUseForSend = this.originalMicTrack
      if (trackToUseForSend) {
        trackToUseForSend.enabled = true // Ensure track is enabled when unmuting
      }
      console.log(
        `[PeerManager sendMuteStatus] Unmuting: Replacing tracks with ${trackToUseForSend?.id}`
      )
    }

    // Update localStream for UI feedback (independent of sending)
    const trackForLocalDisplay = this.isMuted
      ? this.silentAudioTrack ||
        (this.silentAudioTrack = this.createSilentAudioTrack())
      : this.originalMicTrack

    if (this.localStream && trackForLocalDisplay) {
      const currentLocalAudioTrack = this.localStream.getAudioTracks()[0]
      const currentVideoTracks = this.localStream.getVideoTracks() // Keep existing video tracks

      const newLocalStreamTracks: MediaStreamTrack[] = [...currentVideoTracks]
      if (currentLocalAudioTrack?.id !== trackForLocalDisplay.id) {
        // The track instance for local display might be different (e.g., silent track)
      }
      trackForLocalDisplay.enabled = !this.isMuted // Set enabled state for the track in the new stream
      newLocalStreamTracks.push(trackForLocalDisplay)

      // Create a new MediaStream instance to ensure React detects the change
      const newLocalMediaStream = new MediaStream(newLocalStreamTracks)
      this.localStream = newLocalMediaStream // Update internal reference
      console.log(
        `[PeerManager sendMuteStatus] Notifying UI with new localStream ${this.localStream.id} containing audio track ${trackForLocalDisplay.id} (enabled: ${trackForLocalDisplay.enabled})`
      )
      this.options?.onLocalStream(this.localStream) // Notify with the new stream instance
    }

    // Replace tracks for actual P2P connections
    await this.replaceTrackForAllConnections(
      trackToUseForSend,
      'audio',
      this.mediaConnections
    )

    if (this.isCurrentlyScreenSharing) {
      await this.replaceTrackForAllConnections(
        trackToUseForSend,
        'audio',
        this.screenMediaConnections
      )
    }
    this.sendMessage('MUTE_STATUS', this.isMuted)
  }

  private async replaceTrackForAllConnections(
    newTrack: MediaStreamTrack | null,
    kind: 'audio',
    connections: { [id: string]: MediaConnection }
  ) {
    console.log(
      `[PeerManager instance ${this.peer?.id}] Replacing ${kind} track. New track: ${newTrack?.id ?? 'null'}`
    )
    const replacePromises = Object.values(connections).map(async (conn) => {
      const pc = conn.peerConnection as RTCPeerConnection | undefined
      if (pc) {
        const sender = pc.getSenders().find((s) => s.track?.kind === kind)
        if (sender) {
          try {
            await sender.replaceTrack(newTrack)
            console.log(
              `[PeerManager replaceTrackForAllConnections DEBUG] After replaceTrack for ${conn.peer}: sender.track ID: ${sender.track?.id ?? 'null'}, sender.track.enabled: ${sender.track?.enabled}, sender.transport.iceTransport.state: ${sender.transport?.iceTransport.state}`
            )
            // ★★★ ここまで ★★★
            console.log(
              `[PeerManager] Successfully replaced ${kind} track for ${conn.peer} with ${newTrack?.id ?? 'null'}. Sender track now: ${sender.track?.id ?? 'null'}, enabled: ${sender.track?.enabled}`
            )
            // If newTrack is not null (i.e., unmuting), ensure its enabled state is true.
            // If newTrack is null (i.e., muting), sender.track will be null, and enabled doesn't apply.
            if (sender.track) {
              // Check if sender.track exists (it won't if newTrack was null)
              sender.track.enabled = !this.isMuted // This should align with the trackToUseForSend's intended state
              console.log(
                `[PeerManager] Set sender.track ${sender.track.id} for ${conn.peer} enabled to ${sender.track.enabled} (isMuted: ${this.isMuted})`
              )
            }
          } catch (error) {
            console.error(
              `[PeerManager] Failed to replace ${kind} track for ${conn.peer}:`,
              error
            )
          }
        }
      }
    })
    await Promise.all(replacePromises)
  }

  public async switchMicrophone(newDeviceId: string) {
    const oldLocalAudioTrack = this.localStream?.getAudioTracks()[0]
    if (oldLocalAudioTrack?.getSettings().deviceId === newDeviceId) return

    const oldLocalAudioTrackId = oldLocalAudioTrack?.id

    try {
      const newMicStream = await navigator.mediaDevices.getUserMedia({
        audio: newDeviceId ? { deviceId: { exact: newDeviceId } } : true,
      })
      const newAudioTrack = newMicStream.getAudioTracks()[0]
      if (!newAudioTrack) throw new Error('Failed to get new audio track.')

      this.originalMicTrack = newAudioTrack // Update the main mic track reference

      const trackToUseForConnections = this.isMuted
        ? null
        : this.originalMicTrack
      if (this.originalMicTrack && trackToUseForConnections) {
        // Ensure trackToUseForConnections is not null before enabling

        this.originalMicTrack.enabled = true
      }

      console.log(
        `[PeerManager switchMicrophone] New originalMicTrack: ${this.originalMicTrack?.id}. For connections: ${trackToUseForConnections?.id ?? 'null'}`
      )

      await this.replaceTrackForAllConnections(
        trackToUseForConnections,
        'audio',
        this.mediaConnections
      )
      if (this.isCurrentlyScreenSharing) {
        await this.replaceTrackForAllConnections(
          trackToUseForConnections,
          'audio',
          this.screenMediaConnections
        )
      }

      // Update localStream for UI
      // Create a new localStream instance with the new audio track and existing video tracks
      const videoTracks = this.localStream?.getVideoTracks() || []
      const newLocalStreamTracks: MediaStreamTrack[] = [...videoTracks]

      if (this.originalMicTrack) {
        // Add the new audio track
        this.originalMicTrack.enabled = !this.isMuted // Set its state according to current mute status
        newLocalStreamTracks.push(this.originalMicTrack)
      } else {
        // If originalMicTrack is null (shouldn't happen after successful getUserMedia),
        // add the silent track for UI if muted, or just have video if unmuted.
        if (this.isMuted) {
          const silent =
            this.silentAudioTrack ||
            (this.silentAudioTrack = this.createSilentAudioTrack())
          silent.enabled = false
          newLocalStreamTracks.push(silent)
        }
      }

      const newLocalMediaStream = new MediaStream(newLocalStreamTracks)
      this.localStream = newLocalMediaStream // Update internal reference
      console.log(
        `[PeerManager switchMicrophone] Notifying UI with new localStream ${this.localStream.id} containing new audio track ${this.originalMicTrack?.id} (enabled: ${this.originalMicTrack?.enabled})`
      )
      this.options?.onLocalStream(this.localStream) // Notify with the new stream instance

      console.log(
        `[PeerManager switchMicrophone] Switched to ${newDeviceId}. Old track: ${oldLocalAudioTrackId}`
      )
      if (
        oldLocalAudioTrackId &&
        oldLocalAudioTrackId !== this.originalMicTrack?.id
      ) {
        // Consider stopping the very old track if it's still around and not this.originalMicTrack
      }
    } catch (error) {
      console.error('[PeerManager switchMicrophone] Failed:', error)
      throw error
    }
  }

  public async startScreenShareToPeer(peerId: string): Promise<void> {
    if (!this.peer || !this.isCurrentlyScreenSharing || !this.screenStream)
      return
    if (this.screenMediaConnections[peerId]) return

    const streamToShare = new MediaStream()
    const screenVideoTrack = this.screenStream.getVideoTracks()[0]
    if (!screenVideoTrack) return
    streamToShare.addTrack(screenVideoTrack)

    const audioTrackForScreen = this.isMuted ? null : this.originalMicTrack
    if (audioTrackForScreen) {
      // Ensure the track to be shared is enabled if not muted
      audioTrackForScreen.enabled = true
      streamToShare.addTrack(audioTrackForScreen)
    }

    try {
      const screenCall = this.peer.call(peerId, streamToShare, {
        metadata: { type: 'screenShare' },
      })
      if (!screenCall) throw new Error('Failed to initiate screen share call.')
      screenCall.on('close', () => delete this.screenMediaConnections[peerId])
      screenCall.on(
        'error',
        (err) => delete this.screenMediaConnections[peerId]
      )
      this.screenMediaConnections[peerId] = screenCall
    } catch (error) {
      console.error(`Error starting screen share to ${peerId}:`, error)
    }
  }

  public async startScreenShare() {
    if (this.isCurrentlyScreenSharing) return
    this.cleanupAudioMixingResources()

    Object.values(this.mediaConnections).forEach((conn) => {
      const pc = conn.peerConnection as RTCPeerConnection | undefined
      pc?.getSenders().forEach((sender) => {
        if (sender.track?.kind === 'audio' && sender.track) {
          console.log(
            `[PeerManager startScreenShare] Disabling audio track ${sender.track.id} on mediaConnection for ${conn.peer}`
          )
          sender.track.enabled = false // Disable audio on normal call during screen share
        }
      })
    })

    try {
      this.screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true, // Request audio from screen share as well, though we might not use it directly
      })
      const screenVideoTrack = this.screenStream.getVideoTracks()[0]
      if (!screenVideoTrack) throw new Error('No video track in screen stream.')

      this.isCurrentlyScreenSharing = true

      this.screenShareTrackEndedListener = () => this.stopScreenShare()
      screenVideoTrack.addEventListener(
        'ended',
        this.screenShareTrackEndedListener
      )

      const audioTrackForScreenConnections = this.isMuted
        ? null
        : this.originalMicTrack
      if (audioTrackForScreenConnections) {
        audioTrackForScreenConnections.enabled = true // Ensure it's enabled if we are sending it
      }

      // Update screenMediaConnections with the correct audio track (or null)
      // This needs to be done carefully if connections already exist or are made later.
      // For simplicity, we'll update existing ones here. New ones will get it via startScreenShareToPeer.
      Object.values(this.screenMediaConnections).forEach((conn) => {
        const pc = conn.peerConnection as RTCPeerConnection | undefined
        const sender = pc?.getSenders().find((s) => s.track?.kind === 'audio')
        if (sender) {
          sender
            .replaceTrack(audioTrackForScreenConnections)
            .catch((e) =>
              console.error(
                'Error replacing track in existing screen share conn:',
                e
              )
            )
          if (sender.track && audioTrackForScreenConnections)
            sender.track.enabled = true
        }
      })

      const connectedPeerIds = Object.keys(this.dataConnections)
      await Promise.all(
        connectedPeerIds.map((peerId) => this.startScreenShareToPeer(peerId))
      )

      this.options?.onLocalScreenStreamUpdate?.(this.screenStream)
      console.log(`[PeerManager] Screen sharing initiated.`)
    } catch (error) {
      console.error('[PeerManager] Error starting screen share:', error)
      this.cleanupScreenShareResources()
      if (error instanceof Error && error.name === 'NotAllowedError') {
        if (this.socket?.connected) this.socket.emit('notify-stop-share')
      }
      throw error
    }
  }

  public async stopScreenShare() {
    if (!this.isCurrentlyScreenSharing) return
    this.isCurrentlyScreenSharing = false
    this.cleanupScreenShareResources()

    Object.values(this.screenMediaConnections).forEach((conn) => conn.close())
    this.screenMediaConnections = {}

    if (this.socket?.connected) this.socket.emit('notify-stop-share')

    // Re-enable audio on normal media connections based on current mute state
    // The originalMicTrack's enabled state should already reflect the mute status.
    if (this.originalMicTrack) {
      this.originalMicTrack.enabled = !this.isMuted // Ensure it's correct
      console.log(
        `[PeerManager stopScreenShare] Re-enabling originalMicTrack ${this.originalMicTrack.id} for mediaConnections, enabled: ${this.originalMicTrack.enabled}`
      )
    } else {
      console.warn(
        `[PeerManager stopScreenShare] originalMicTrack is null, cannot re-enable audio for mediaConnections.`
      )
    }
    // Replace track on mediaConnections to ensure they use the (potentially re-enabled) originalMicTrack
    await this.replaceTrackForAllConnections(
      this.originalMicTrack, // Send the originalMicTrack, its 'enabled' property dictates mute
      'audio',
      this.mediaConnections
    )
    console.log(`[PeerManager] Screen sharing stopped.`)
  }

  private cleanupAudioMixingResources() {
    if (this.audioMixingResources) {
      const {
        audioContext,
        micSource,
        screenSource,
        destination,
        mixedAudioTrack,
      } = this.audioMixingResources
      try {
        mixedAudioTrack?.stop()
        micSource?.disconnect()
        screenSource?.disconnect()
        destination?.disconnect()
        audioContext
          ?.close()
          .catch((e) => console.error('Error closing mixing AudioContext:', e))
      } catch (e) {
        console.error('Error during audio mixing resource cleanup:', e)
      } finally {
        this.audioMixingResources = null
      }
    }
  }

  private cleanupScreenShareResources() {
    const screenVideoTrack = this.screenStream?.getVideoTracks()[0]
    if (this.screenShareTrackEndedListener && screenVideoTrack) {
      try {
        screenVideoTrack.removeEventListener(
          'ended',
          this.screenShareTrackEndedListener
        )
      } catch (removeError) {
        console.error("Error removing 'ended' listener:", removeError)
      }
      this.screenShareTrackEndedListener = null
    }
    this.screenStream?.getTracks().forEach((track) => track.stop())
    this.screenStream = null
    this.options?.onLocalScreenStreamUpdate?.(null)
    this.cleanupAudioMixingResources()
  }

  public disconnectAll() {
    this.isCurrentlyScreenSharing = false
    this.cleanupScreenShareResources()
    this.stopAllAudioAnalysis()

    Object.values(this.mediaConnections).forEach((conn) => conn.close())
    Object.values(this.dataConnections).forEach((conn) => conn.close())
    Object.values(this.screenMediaConnections).forEach((conn) => conn.close())
    this.mediaConnections = {}
    this.dataConnections = {}
    this.screenMediaConnections = {}

    if (this.peer && !this.peer.destroyed) this.peer.destroy()
    this.peer = null

    this.localStream?.getTracks().forEach((track) => track.stop())
    this.localStream = null
    this.originalMicTrack = null
    this.silentAudioTrack?.stop()
    this.silentAudioTrack = null

    this.options = null
    this.myName = ''
    this.isMuted = false
    console.log(`[PeerManager instance] Disconnected and resources released.`)
  }
}
