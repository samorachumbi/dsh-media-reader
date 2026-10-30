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
            'x-media-reader-name': encodeURIComponent(file.name)
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
        if (list.length === 0 || busy) return
        if (props.inputActions === undefined || typeof props.inputActions.setDraft !== 'function') {
          setStatus('composer draft is unavailable')
          return
        }
        setBusy(true)
        try {
          for (const file of list) {
            setStatus(`Analyzing ${file.name}…`)
            const result = await uploadOne(file)
            const block = `[media: ${file.name}]\n${String(result.text ?? '').trim()}`
            const current = draftRef.current ?? ''
            const next = current.trim().length > 0 ? `${current}\n\n${block}` : block
            props.inputActions.setDraft(next)
            draftRef.current = next
            setStatus(`Added ${file.name} to the draft`)
          }
        } catch (error) {
          setStatus(`Failed: ${String(error?.message ?? error)}`)
        } finally {
          setBusy(false)
        }
      }
      processRef.current = processFiles

      React.useEffect(() => {
        const node = nodeRef.current
        if (node === null) return undefined
        // Find the composer container without depending on hashed class names:
        // the nearest ancestor that already contains the composer textarea.
        let root = node
        let ancestor = node.parentElement
        while (ancestor !== null && ancestor !== document.body) {
          if (typeof ancestor.querySelector === 'function' && ancestor.querySelector('textarea') !== null) {
            root = ancestor
            break
          }
          ancestor = ancestor.parentElement
        }

        const onDragOver = (event) => {
          if (!hasFiles(event)) return
          event.preventDefault()
          event.stopPropagation()
          setOver(true)
        }
        const onDragLeave = (event) => {
          if (event.relatedTarget !== null && root.contains(event.relatedTarget)) return
          setOver(false)
        }
        const onDrop = (event) => {
          if (!hasFiles(event)) return
          event.preventDefault()
          event.stopPropagation()
          setOver(false)
          const files = event.dataTransfer?.files
          if (files !== undefined && files !== null) processRef.current(files)
        }
        root.addEventListener('dragover', onDragOver, true)
        root.addEventListener('dragleave', onDragLeave, true)
        root.addEventListener('drop', onDrop, true)
        return () => {
          root.removeEventListener('dragover', onDragOver, true)
          root.removeEventListener('dragleave', onDragLeave, true)
          root.removeEventListener('drop', onDrop, true)
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
