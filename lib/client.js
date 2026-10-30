/**
 * Client half of dsh-media-reader — drag-and-drop media into the composer.
 *
 * Why this exists: a text-only route refuses attached images before any tool
 * runs, and DSH has no audio/video attachment modality at all. Dropping a file
 * here sends its bytes to the plugin's host route, gets text back, and inserts
 * that text into the current draft — so the user does not have to copy a path.
 *
 * The drop target is registered into `conversation.input.left`. It also listens
 * on the nearest ancestor containing the composer textarea, so a file can be
 * dropped anywhere in the composer, not only on the button.
 */
window.__ModuleLoader__.load({
  id: 'dsh-media-reader',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')

    const MAX_BYTES = 128 * 1024 * 1024
    const MEDIA_EXTENSION = /\.(png|jpe?g|webp|gif|mp3|wav|m4a|aac|flac|ogg|opus|mp4|mov|mkv|webm|m4v|avi|mpeg|mpg)$/iu
    const MIME_EXTENSION = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/webp': 'webp',
      'image/gif': 'gif',
      'audio/mpeg': 'mp3',
      'audio/wav': 'wav',
      'audio/x-wav': 'wav',
      'audio/mp4': 'm4a',
      'audio/aac': 'aac',
      'audio/flac': 'flac',
      'audio/ogg': 'ogg',
      'video/mp4': 'mp4',
      'video/quicktime': 'mov',
      'video/webm': 'webm',
      'video/x-matroska': 'mkv'
    }

    function isMediaFile(file) {
      if (file === null || file === undefined) return false
      if (MEDIA_EXTENSION.test(file.name ?? '')) return true
      return typeof file.type === 'string' && /^(image|audio|video)\//u.test(file.type)
    }

    function uploadName(file) {
      const name = String(file.name ?? '').trim()
      if (MEDIA_EXTENSION.test(name)) return name
      const extension = MIME_EXTENSION[String(file.type ?? '').toLowerCase()]
      return extension === undefined ? name : `pasted.${extension}`
    }

    const BOX = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      border: '1px dashed rgba(128,128,128,.45)',
      borderRadius: '8px',
      padding: '3px 9px',
      fontSize: '12px',
      lineHeight: '1.6',
      cursor: 'pointer',
      userSelect: 'none',
      whiteSpace: 'nowrap',
      background: 'transparent',
      color: 'inherit'
    }
    const STATUS = {
      fontSize: '11px',
      color: '#888',
      maxWidth: '260px',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap'
    }

    function hasFiles(event) {
      const types = event && event.dataTransfer && event.dataTransfer.types
      if (types === undefined || types === null) return false
      for (const type of types) if (type === 'Files') return true
      return false
    }

    function formatError(payload, fallback) {
      if (payload && typeof payload.error === 'string' && payload.error.length > 0) return payload.error
      return fallback
    }

    function MediaDrop(props) {
      const [busy, setBusy] = React.useState(false)
      const [over, setOver] = React.useState(false)
      const [status, setStatus] = React.useState('')
      const nodeRef = React.useRef(null)
      const fileRef = React.useRef(null)
      const draftRef = React.useRef(props.input?.draft ?? '')
      const processRef = React.useRef(null)

      React.useEffect(() => {
        draftRef.current = props.input?.draft ?? ''
      }, [props.input?.draft])

      async function uploadOne(file) {
        if (file.size > MAX_BYTES) throw new Error(`file is larger than ${Math.round(MAX_BYTES / (1024 * 1024))} MB`)
        const response = await fetch('/media-reader/ingest', {
          method: 'POST',
          headers: {
            'content-type': 'application/octet-stream',
            'x-media-reader-client': '1',
            'x-media-reader-name': encodeURIComponent(uploadName(file))
          },
          body: file
        })
        const payload = await response.json().catch(() => ({}))
        if (response.ok !== true || payload.ok !== true) {
          throw new Error(formatError(payload, `host returned HTTP ${response.status}`))
        }
        return payload
      }

      async function processFiles(files) {
        const list = [...files].filter((file) => file && file.size > 0)
        const supported = list.filter(isMediaFile)
        if (supported.length === 0) {
          setStatus('No supported image/audio/video file in that drop')
          return
        }
        if (busy) return
        if (props.inputActions === undefined || typeof props.inputActions.setDraft !== 'function') {
          setStatus('composer draft is unavailable')
          return
        }
        setBusy(true)
        try {
          for (const file of supported) {
            const label = uploadName(file)
            setStatus(`Analyzing ${label}…`)
            const result = await uploadOne(file)
            const block = `[media: ${label}]\n${String(result.text ?? '').trim()}`
            const current = draftRef.current ?? ''
            const next = current.trim().length > 0 ? `${current}\n\n${block}` : block
            props.inputActions.setDraft(next)
            draftRef.current = next
            setStatus(`Added ${label} to the draft`)
          }
        } catch (error) {
          setStatus(`Failed: ${String(error?.message ?? error)}`)
        } finally {
          setBusy(false)
        }
      }
      processRef.current = processFiles

      React.useEffect(() => {
        // Capture on window, not a guessed DOM root. The host's native attachment
        // handler rejects MP4/MP3 with "Only PNG, JPG, WebP, and GIF images are
        // supported"; a capture listener here runs first and stops that handler.
        const hasFileDrag = (event) => {
          const transfer = event.dataTransfer
          if (transfer === null || transfer === undefined) return false
          if (typeof transfer.types !== 'undefined' && transfer.types !== null) {
            for (const type of transfer.types) if (type === 'Files') return true
          }
          if (typeof transfer.items !== 'undefined' && transfer.items !== null) {
            for (const item of transfer.items) if (item.kind === 'file') return true
          }
          return (transfer.files?.length ?? 0) > 0
        }
        const onDragOver = (event) => {
          if (!hasFileDrag(event)) return
          event.preventDefault()
          event.stopPropagation()
          if (event.dataTransfer !== null && event.dataTransfer !== undefined) {
            try { event.dataTransfer.dropEffect = 'copy' } catch { /* some browsers refuse during drag */ }
          }
          setOver(true)
        }
        const onDragLeave = (event) => {
          if (event.relatedTarget === null || event.target === document.documentElement) setOver(false)
        }
        const onDrop = (event) => {
          if (!hasFileDrag(event)) return
          event.preventDefault()
          event.stopPropagation()
          setOver(false)
          const files = event.dataTransfer?.files
          if (files !== undefined && files !== null) processRef.current(files)
        }
        const onPaste = (event) => {
          const files = event.clipboardData?.files
          if (files === undefined || files === null || files.length === 0) return
          const supported = [...files].filter(isMediaFile)
          if (supported.length === 0) return
          event.preventDefault()
          event.stopPropagation()
          processRef.current(files)
        }
        window.addEventListener('dragover', onDragOver, true)
        window.addEventListener('dragleave', onDragLeave, true)
        window.addEventListener('drop', onDrop, true)
        window.addEventListener('paste', onPaste, true)
        return () => {
          window.removeEventListener('dragover', onDragOver, true)
          window.removeEventListener('dragleave', onDragLeave, true)
          window.removeEventListener('drop', onDrop, true)
          window.removeEventListener('paste', onPaste, true)
        }
      }, [])

      const openPicker = () => {
        if (busy) return
        if (fileRef.current !== null) fileRef.current.click()
      }

      return React.createElement('span', {
        ref: nodeRef,
        style: { display: 'inline-flex', alignItems: 'center', gap: '6px', maxWidth: '100%' },
        'data-media-reader-drop': over ? 'over' : 'idle'
      },
        React.createElement('button', {
          type: 'button',
          style: {
            ...BOX,
            borderColor: over ? 'var(--dsw-alias-text-accent, #4f8cff)' : 'rgba(128,128,128,.45)',
            background: over ? 'color-mix(in srgb, var(--dsw-alias-text-accent, #4f8cff) 12%, transparent)' : 'transparent'
          },
          onClick: openPicker,
          disabled: busy,
          title: 'Drop an image, audio or video file here, or click to choose one. The analysis is inserted into the draft as text.'
        }, busy ? '⏳ Analyzing…' : '📎 Drop media'),
        React.createElement('input', {
          ref: fileRef,
          type: 'file',
          accept: 'image/*,audio/*,video/*',
          multiple: true,
          style: { display: 'none' },
          onChange: (event) => {
            const files = event.target.files
            if (files !== null && files !== undefined) processRef.current(files)
            event.target.value = ''
          }
        }),
        status.length > 0 ? React.createElement('span', { style: STATUS, title: status }, status) : null
      )
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      ctx.effect(() => slots.inject('conversation.input.left', () => slots.register(
        { name: 'conversation.input.left', id: 'media-reader-drop' },
        (props) => React.createElement(MediaDrop, props)
      )))
    }

    exports.apply = apply
    return module.exports
  }
})
