// src/app/components/PeerManager/index.ts
import Peer, { MediaConnection, DataConnection } from 'peerjs'

// --- インターフェースと型定義 ---
type Message =
  | { type: 'USER_NAME'; payload: string }
  | { type: 'MUTE_STATUS'; payload: boolean }
  | { type: 'SCREEN_SHARE_STATUS'; payload: boolean }

export type InitPeerOptions = {
  roomCode: string // roomCode は PeerManager 内部では直接使わないかも
  onReceiveStream: (stream: MediaStream, peerId: string) => void
  onReceiveScreenStream: (stream: MediaStream, peerId: string) => void
  onPeerOpen: (id: string) => void
  onLocalStream: (stream: MediaStream) => void
  onReceiveUserName: (peerId: string, name: string) => void
  onReceiveMuteStatus: (peerId: string, isMuted: boolean) => void
  onPeerDisconnect: (peerId: string) => void
  onSpeakingStatusChange?: (peerId: string, isSpeaking: boolean) => void
  onReceiveScreenShareStatus?: (peerId: string, isSharing: boolean) => void
}

interface AudioAnalysisData {
  context: AudioContext
  analyser: AnalyserNode
  source: MediaStreamAudioSourceNode
  lastIsSpeaking: boolean
  animationFrameId: number | null
  dataArray: Uint8Array
}

// --- PeerManager クラス定義 ---
export class PeerManager {
  private peer: Peer | null = null
  private localStream: MediaStream | null = null
  private screenStream: MediaStream | null = null
  private originalVideoTrack: MediaStreamTrack | null = null
  private screenShareTrackEndedListener: (() => void) | null = null
  private mediaConnections: { [id: string]: MediaConnection } = {}
  private dataConnections: { [id: string]: DataConnection } = {}
  private options: InitPeerOptions | null = null // オプションを保持
  private myName = ''
  private isMuted = false
  private audioAnalysisMap = new Map<string, AudioAnalysisData>()
  private readonly speakingThreshold = 10

  // --- 型ガード関数 ---
  private isMessage(data: unknown): data is Message {
    if (typeof data !== 'object' || data === null) return false
    if (!('type' in data) || !('payload' in data)) return false
    const potentialMessage = data as { type: unknown; payload: unknown }
    switch (potentialMessage.type) {
      case 'USER_NAME':
        return typeof potentialMessage.payload === 'string'
      case 'MUTE_STATUS':
      case 'SCREEN_SHARE_STATUS':
        return typeof potentialMessage.payload === 'boolean'
      default:
        return false
    }
  }

  // --- 音声分析関連メソッド ---
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
          console.log(
            `[PeerManager instance ${this.peer?.id}] Speaking status changed for ${peerId}: ${isSpeaking}`
          )
          currentAnalysisData.lastIsSpeaking = isSpeaking
          this.options?.onSpeakingStatusChange?.(peerId, isSpeaking)
        }
      }
      analyse()
      console.log(
        `[PeerManager instance ${this.peer?.id}] Started audio analysis for ${peerId}`
      )
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
      console.log(
        `[PeerManager instance ${this.peer?.id}] Stopped audio analysis for ${peerId}`
      )
      this.options?.onSpeakingStatusChange?.(peerId, false)
    }
  }

  private stopAllAudioAnalysis() {
    this.audioAnalysisMap.forEach((_, peerId) => this.stopAudioAnalysis(peerId))
    this.audioAnalysisMap.clear()
  }

  // --- 接続処理関連メソッド ---
  private setupDataConnectionHandlers(dataConn: DataConnection) {
    dataConn.on('open', () => {
      console.log(
        `[PeerManager instance ${this.peer?.id}] Data connection opened with ${dataConn.peer}`
      )
      this.dataConnections[dataConn.peer] = dataConn
      this.sendMessage('USER_NAME', this.myName, dataConn.peer)
      this.sendMessage('MUTE_STATUS', this.isMuted, dataConn.peer)
      if (this.screenStream)
        this.sendMessage('SCREEN_SHARE_STATUS', true, dataConn.peer)
    })
    dataConn.on('data', (data) => {
      console.log(
        `[PeerManager instance ${this.peer?.id}] Received data from ${dataConn.peer}:`,
        data
      )
      if (this.isMessage(data) && this.options) {
        switch (data.type) {
          case 'USER_NAME':
            this.options.onReceiveUserName(dataConn.peer, data.payload)
            break
          case 'MUTE_STATUS':
            this.options.onReceiveMuteStatus(dataConn.peer, data.payload)
            break
          case 'SCREEN_SHARE_STATUS':
            this.options.onReceiveScreenShareStatus?.(
              dataConn.peer,
              data.payload
            )
            break
        }
      } else {
        console.warn(
          `[PeerManager instance ${this.peer?.id}] Received unknown message type:`,
          data
        )
      }
    })
    dataConn.on('close', () => {
      console.log(
        `[PeerManager instance ${this.peer?.id}] Data connection with ${dataConn.peer} closed.`
      )
      this.handleDisconnect(dataConn.peer)
    })
    dataConn.on('error', (err) => {
      console.error(
        `[PeerManager instance ${this.peer?.id}] Data connection error with ${dataConn.peer}:`,
        err
      )
      this.handleDisconnect(dataConn.peer)
    })
  }

  private handleDisconnect(peerId: string) {
    if (!peerId) return
    console.log(
      `[PeerManager instance ${this.peer?.id}] Handling disconnect for peer: ${peerId}`
    )
    this.stopAudioAnalysis(peerId)
    if (this.mediaConnections[peerId]) {
      this.mediaConnections[peerId].close()
      delete this.mediaConnections[peerId]
      console.log(
        `[PeerManager instance ${this.peer?.id}] Closed media connection with ${peerId}`
      )
    }
    if (this.dataConnections[peerId]) {
      this.dataConnections[peerId].close()
      delete this.dataConnections[peerId]
      console.log(
        `[PeerManager instance ${this.peer?.id}] Closed data connection with ${peerId}`
      )
    }
    this.options?.onPeerDisconnect(peerId)
  }

  // --- メディアストリーム関連メソッド ---
  private async getLocalStream(deviceId?: string): Promise<MediaStream> {
    const currentAudioTrack = this.localStream?.getAudioTracks()[0]
    if (
      this.localStream &&
      (!deviceId || currentAudioTrack?.getSettings().deviceId === deviceId)
    ) {
      console.log(
        `[PeerManager instance ${this.peer?.id}] Returning cached local stream.`
      )
      return this.localStream
    }

    this.localStream?.getTracks().forEach((track) => track.stop())
    this.localStream = null
    console.log(
      `[PeerManager instance ${this.peer?.id}] Stopped existing local stream.`
    )

    try {
      console.log(
        `[PeerManager instance ${this.peer?.id}] Requesting local media stream (getUserMedia) with deviceId: ${deviceId || 'default'}`
      )
      const constraints: MediaStreamConstraints = {
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      }
      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      console.log(
        `[PeerManager instance ${this.peer?.id}] getUserMedia successful!`
      )
      this.localStream = stream
      this.options?.onLocalStream(stream)
      console.log(
        `[PeerManager instance ${this.peer?.id}] Local media stream obtained and notified.`
      )
      const audioTrack = stream.getAudioTracks()[0]
      if (audioTrack) {
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

  private async replaceTrackForAllConnections(
    newTrack: MediaStreamTrack | null,
    kind: 'audio' | 'video'
  ) {
    console.log(
      `[PeerManager instance ${this.peer?.id}] Replacing ${kind} track for all connections with track:`,
      newTrack?.id ?? 'null' // トラックIDもログに出す
    )
    // ★ 接続がない場合は何もしない
    if (Object.keys(this.mediaConnections).length === 0) {
      console.log(
        `[PeerManager instance ${this.peer?.id}] No media connections to replace track on.`
      )
      return
    }

    for (const peerId in this.mediaConnections) {
      const conn = this.mediaConnections[peerId]
      const peerConnection = conn.peerConnection as
        | RTCPeerConnection
        | undefined
      if (peerConnection) {
        const sender = peerConnection
          .getSenders()
          .find((s) => s.track?.kind === kind)
        if (sender) {
          console.log(
            `[PeerManager instance ${this.peer?.id}] Replacing ${kind} track for connection with ${peerId}`
          )
          try {
            console.log(
              `[PeerManager instance ${this.peer?.id}] Attempting sender.replaceTrack() for ${peerId}...`
            )
            await sender.replaceTrack(newTrack)
            console.log(
              // ★ 成功ログを追加
              `[PeerManager instance ${this.peer?.id}] Successfully replaced ${kind} track for ${peerId}. New track: ${sender.track?.id ?? 'null'}`
            )
          } catch (replaceError) {
            console.error(
              // ★ エラーログをより詳細に
              `[PeerManager instance ${this.peer?.id}] Failed to replace ${kind} track for ${peerId}:`,
              replaceError
            )
          }
        } else if (newTrack && this.localStream) {
          // この部分は通常、最初の接続時に使われるはず
          console.log(
            `[PeerManager instance ${this.peer?.id}] Sender for ${kind} not found. Attempting peerConnection.addTrack() for ${peerId}`
          )
          try {
            peerConnection.addTrack(newTrack, this.localStream)
            console.log(
              // ★ 成功ログを追加
              `[PeerManager instance ${this.peer?.id}] Successfully added ${kind} track for ${peerId}.`
            )
          } catch (addError) {
            console.error(
              `[PeerManager instance ${this.peer?.id}] Failed to add ${kind} track for ${peerId}:`,
              addError
            )
          }
        } else {
          console.warn(
            `[PeerManager instance ${this.peer?.id}] Could not find sender for ${kind} and no new track to add for ${peerId}.`
          )
        }
      } else {
        console.warn(
          `[PeerManager instance ${this.peer?.id}] No peerConnection found for media connection with ${peerId}.`
        )
      }
    }
  }

  // --- メッセージ送信メソッド --
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
          console.log(
            `[PeerManager instance ${this.peer?.id}] Sending ${type} to ${targetId}:`,
            payload
          )
          this.dataConnections[targetId].send(message)
        } else {
          console.warn(
            `[PeerManager instance ${this.peer?.id}] Data connection to ${targetId} not open or doesn't exist.`
          )
        }
      } else {
        console.log(
          `[PeerManager instance ${this.peer?.id}] Sending ${type} to all connected peers:`,
          payload
        )
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

  // --- 公開メソッド ---
  public async initPeer(
    options: InitPeerOptions,
    peerName: string,
    initialIsMuted: boolean = false
  ): Promise<string> {
    console.log('[PeerManager instance] initPeer called.')
    this.options = options
    this.myName = peerName
    this.isMuted = initialIsMuted

    if (this.peer) {
      console.error(
        '[PeerManager instance] initPeer called on an already initialized instance. Destroying previous peer.'
      )
      this.peer.destroy()
      this.peer = null
    }

    return new Promise<string>(async (resolve, reject) => {
      try {
        console.log('[PeerManager instance] Creating new Peer.')
        this.peer = new Peer()

        this.peer.on('open', async (id) => {
          if (!this.peer || this.peer.destroyed) {
            console.warn(
              `[PeerManager instance] on 'open' called for ID ${id}, but instance peer is null or destroyed.`
            )
            return
          }
          console.log('[PeerManager instance] Peer opened with ID:', id)
          try {
            await this.getLocalStream()
            this.options?.onPeerOpen(id)
            resolve(id)
          } catch (streamError) {
            console.error(
              '[PeerManager instance] Failed to get local stream on peer open:',
              streamError
            )
            if (this.peer && !this.peer.destroyed) {
              this.peer.destroy()
              this.peer = null
            }
            reject(new Error('マイクへのアクセスに失敗しました。'))
          }
        })

        this.peer.on('connection', (dataConn) => {
          console.log(
            `[PeerManager instance ${this.peer?.id}] Incoming data connection from ${dataConn.peer}`
          )
          this.setupDataConnectionHandlers(dataConn)
        })

        this.peer.on('call', async (call) => {
          console.log(
            `[PeerManager instance ${this.peer?.id}] Incoming call from ${call.peer}`
          )
          try {
            if (!this.localStream) await this.getLocalStream()
            if (!this.localStream) {
              console.error(
                `[PeerManager instance ${this.peer?.id}] Local stream is null. Cannot answer call.`
              )
              return
            }
            call.answer(this.localStream)
            call.on('stream', (remoteStream) => {
              console.log(
                `[PeerManager instance ${this.peer?.id}] ★★★ Received 'stream' event from ${call.peer}. Stream ID: ${remoteStream.id}`
              )
              console.log(
                `    Audio Tracks: ${remoteStream.getAudioTracks().length}, Video Tracks: ${remoteStream.getVideoTracks().length}`
              )
              remoteStream.getTracks().forEach((track) => {
                console.log(
                  `    - Track: kind=${track.kind}, id=${track.id}, label=${track.label}, readyState=${track.readyState}`
                )
              })

              if (remoteStream.getVideoTracks().length > 0) {
                console.log(
                  `[PeerManager instance ${this.peer?.id}] Detected VIDEO stream from ${call.peer}. Calling onReceiveScreenStream.`
                ) // 確認用ログ
                this.options?.onReceiveScreenStream(remoteStream, call.peer)
              } else {
                console.log(
                  `[PeerManager instance ${this.peer?.id}] Detected AUDIO stream from ${call.peer}. Calling onReceiveStream.`
                ) // 確認用ログ
                this.options?.onReceiveStream(remoteStream, call.peer)
                this.startAudioAnalysis(call.peer, remoteStream)
              }
            })
            call.on('close', () => this.handleDisconnect(call.peer))
            call.on('error', (err) => {
              console.error(
                `[PeerManager instance ${this.peer?.id}] Call error with ${call.peer}:`,
                err
              )
              this.handleDisconnect(call.peer)
            })
            this.mediaConnections[call.peer] = call
          } catch (err) {
            console.error(
              `[PeerManager instance ${this.peer?.id}] Error answering call:`,
              err
            )
          }
        })

        this.peer.on('disconnected', () =>
          console.warn(
            `[PeerManager instance ${this.peer?.id}] Peer disconnected from server.`
          )
        )
        this.peer.on('close', () => {
          console.log(
            `[PeerManager instance ${this.peer?.id}] Peer connection closed.`
          )
          this.peer = null
        })
        this.peer.on('error', (err) => {
          console.error(
            `[PeerManager instance ${this.peer?.id}] PeerJS error:`,
            err
          )
          if (err.type === 'peer-unavailable') {
            const unavailablePeerId = err.message.match(/peer\s(.*?)\s/)?.[1]
            if (unavailablePeerId) this.handleDisconnect(unavailablePeerId)
          }
          if (
            ['server-error', 'socket-error', 'socket-closed'].includes(err.type)
          ) {
            if (this.peer && !this.peer.destroyed) {
              this.peer.destroy()
            }
            this.peer = null
          }
        })
      } catch (err) {
        console.error(
          '[PeerManager instance] Failed to initialize PeerJS:',
          err
        )
        if (this.peer && !this.peer.destroyed) {
          this.peer.destroy()
        }
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
        console.log(
          `[PeerManager instance ${this.peer?.id}] Attempting to establish data connection with ${targetId}`
        )
        const dataConn = this.peer.connect(targetId)
        dataConn.on('open', () => {
          this.setupDataConnectionHandlers(dataConn)
          resolve(dataConn)
        })
        dataConn.on('error', (err) => {
          console.error(
            `[PeerManager instance ${this.peer?.id}] Data connection error with ${targetId}:`,
            err
          )
          delete this.dataConnections[targetId]
          resolve(null)
        })
      } catch (error) {
        console.error(
          `[PeerManager instance ${this.peer?.id}] Unexpected error in connectData for ${targetId}:`,
          error
        )
        resolve(null)
      }
    })
  }

  public async callPeer(targetId: string) {
    console.log(
      `[PeerManager instance ${this.peer?.id}] callPeer START for ${targetId}.`
    )
    if (!this.peer || !this.options) return
    if (this.mediaConnections[targetId]) return

    try {
      await this.connectData(targetId)
      if (!this.localStream) await this.getLocalStream()
      if (!this.peer || !this.localStream) return

      console.log(
        `[PeerManager instance ${this.peer?.id}] Calling peer: ${targetId}`
      )
      const call = this.peer.call(targetId, this.localStream)
      call.on('stream', (remoteStream) => {
        console.log(
          `[PeerManager instance ${this.peer?.id}] Received stream from ${targetId} (on call)`
        )
        if (remoteStream.getVideoTracks().length > 0) {
          this.options?.onReceiveScreenStream(remoteStream, call.peer)
        } else {
          this.options?.onReceiveStream(remoteStream, call.peer)
          this.startAudioAnalysis(call.peer, remoteStream)
        }
      })
      call.on('close', () => this.handleDisconnect(targetId))
      call.on('error', (err) => {
        console.error(
          `[PeerManager instance ${this.peer?.id}] Call error with ${targetId}:`,
          err
        )
        this.handleDisconnect(targetId)
      })
      this.mediaConnections[targetId] = call
    } catch (err) {
      console.error(
        `[PeerManager instance ${this.peer?.id}] Error calling peer ${targetId}:`,
        err
      )
      this.handleDisconnect(targetId)
    }
  }

  public sendUserName(name: string) {
    this.myName = name
    this.sendMessage('USER_NAME', name)
  }

  public sendMuteStatus(muted: boolean) {
    this.isMuted = muted
    this.localStream
      ?.getAudioTracks()
      .forEach((track) => (track.enabled = !this.isMuted))
    this.sendMessage('MUTE_STATUS', this.isMuted)
  }

  public async switchMicrophone(newDeviceId: string) {
    console.log(
      `[PeerManager instance ${this.peer?.id}] Attempting to switch microphone to ${newDeviceId}`
    )
    const currentAudioTrack = this.localStream?.getAudioTracks()[0]
    if (currentAudioTrack?.getSettings().deviceId === newDeviceId) return

    try {
      const newStream = await this.getLocalStream(newDeviceId)
      const newAudioTrack = newStream.getAudioTracks()[0]
      if (!newAudioTrack) throw new Error('Failed to get new audio track.')
      await this.replaceTrackForAllConnections(newAudioTrack, 'audio')
      console.log(
        `[PeerManager instance ${this.peer?.id}] Microphone switched successfully.`
      )
    } catch (error) {
      console.error(
        `[PeerManager instance ${this.peer?.id}] Failed to switch microphone:`,
        error
      )
      throw error
    }
  }

  public async startScreenShare() {
    console.log(
      `[PeerManager instance ${this.peer?.id}] Attempting to start screen share.`
    )
    if (this.screenStream) return
    let screenVideoTrack: MediaStreamTrack | undefined
    try {
      this.screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      })
      screenVideoTrack = this.screenStream.getVideoTracks()[0]
      if (!screenVideoTrack)
        throw new Error('Failed to get video track from screen stream.')

      this.originalVideoTrack = this.localStream?.getVideoTracks()[0] || null

      this.screenShareTrackEndedListener = () => this.stopScreenShare()
      screenVideoTrack.addEventListener(
        'ended',
        this.screenShareTrackEndedListener
      )

      await this.replaceTrackForAllConnections(screenVideoTrack, 'video')
      this.sendMessage('SCREEN_SHARE_STATUS', true)
      console.log(
        `[PeerManager instance ${this.peer?.id}] Screen sharing started and notified.`
      )
    } catch (error) {
      console.error(
        `[PeerManager instance ${this.peer?.id}] Failed to start screen share:`,
        error
      )
      const tracksToStop = this.screenStream?.getTracks()
      tracksToStop?.forEach((track) => track.stop())
      this.screenStream = null
      if (this.screenShareTrackEndedListener && screenVideoTrack) {
        try {
          screenVideoTrack.removeEventListener(
            'ended',
            this.screenShareTrackEndedListener
          )
        } catch (removeError) {
          console.error("Error removing 'ended' listener:", removeError)
        }
      }
      this.screenShareTrackEndedListener = null
      this.originalVideoTrack = null
      throw error
    }
  }

  public async stopScreenShare() {
    console.log(
      `[PeerManager instance ${this.peer?.id}] Attempting to stop screen share.`
    )
    if (!this.screenStream) return
    const screenVideoTrack = this.screenStream.getVideoTracks()[0]

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

    this.screenStream.getTracks().forEach((track) => track.stop())
    this.screenStream = null

    try {
      await this.replaceTrackForAllConnections(this.originalVideoTrack, 'video')
      this.originalVideoTrack = null
      this.sendMessage('SCREEN_SHARE_STATUS', false)
      console.log(
        `[PeerManager instance ${this.peer?.id}] Screen sharing stopped and notified.`
      )
    } catch (error) {
      console.error(
        `[PeerManager instance ${this.peer?.id}] Error during track replacement/message sending in stopScreenShare:`,
        error
      )
    }
  }

  public disconnectAll() {
    console.log(`[PeerManager instance ${this.peer?.id}] disconnectAll called.`)
    this.stopScreenShare()
    this.stopAllAudioAnalysis()

    Object.values(this.mediaConnections).forEach((conn) => conn.close())
    Object.values(this.dataConnections).forEach((conn) => conn.close())

    this.mediaConnections = {}
    this.dataConnections = {}

    if (this.peer && !this.peer.destroyed) {
      console.log(
        `[PeerManager instance ${this.peer?.id}] Destroying peer instance.`
      )
      this.peer.destroy()
    }
    this.peer = null

    this.localStream?.getTracks().forEach((track) => track.stop())
    this.localStream = null
    this.screenStream?.getTracks().forEach((track) => track.stop())
    this.screenStream = null
    this.originalVideoTrack = null
    this.screenShareTrackEndedListener = null

    this.options = null
    this.myName = ''
    this.isMuted = false

    console.log(`[PeerManager instance] Disconnected and resources released.`)
  }
}
