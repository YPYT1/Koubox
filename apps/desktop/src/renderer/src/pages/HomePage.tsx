import { useRef, useEffect, type FormEvent } from 'react'
import { MagnifyingGlass } from '@phosphor-icons/react'
import type { ToolManifest } from '@koubox/shared'
import viralMaterialsIcon from '../../../../../../png/爆款素材获取.png'
import preciseSrtIcon from '../../../../../../png/精准 SRT 对齐.png'
import videoDownloaderIcon from '../../../../../../png/downloder.png'

type HomePageProps = {
  tools: ToolManifest[]
  query: string
  onQueryChange: (query: string) => void
  onOpenTool: (tool: ToolManifest) => void
}

const toolImages: Record<string, string> = {
  'viral-materials': viralMaterialsIcon,
  'precise-srt': preciseSrtIcon,
  'video-downloader': videoDownloaderIcon
}

const chipClassByTag: Record<string, string> = {
  URL: 'chip-url',
  Video: 'chip-video',
  Audio: 'chip-audio',
  Transcript: 'chip-transcript',
  Translation: 'chip-translation',
  Text: 'chip-text',
  SRT: 'chip-srt'
}

export function HomePage({ tools, query, onQueryChange, onOpenTool }: HomePageProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const filteredTools = tools.filter((tool) =>
    `${tool.name} ${tool.description}`.toLowerCase().includes(query.toLowerCase())
  )

  const handleFormSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (filteredTools.length > 0) {
      onOpenTool(filteredTools[0])
    }
  }

  return (
    <div className="page-container">
      <div className="home-toolbar">
        <div className="page-header-block" style={{ marginBottom: 0 }}>
          <h1>工具箱</h1>
          <p>从链接提取素材，或对齐生成剪映标准 SRT</p>
        </div>
        <form className="search-input-pill home-search" onSubmit={handleFormSubmit}>
          <MagnifyingGlass size={18} weight="bold" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="搜索工具名称或功能描述…"
          />
        </form>
      </div>

      <div className="tools-grid-section">
        <div className="section-header">
          <h2>可用工具</h2>
          <span>共 {tools.length} 款</span>
        </div>

        <div className="tools-grid">
          {filteredTools.map((tool) => {
            const image = toolImages[tool.id]
            const isBlue = tool.accent === 'blue'
            return (
              <article
                key={tool.id}
                className={`tool-card ${isBlue ? 'blue' : ''}`}
                onClick={() => onOpenTool(tool)}
                tabIndex={0}
                role="button"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onOpenTool(tool)
                  }
                }}
              >
                <div className="tool-card-top">
                  <div className="tool-card-icon">
                    {image ? <img src={image} alt="" /> : null}
                  </div>
                  <div className="tool-card-body">
                    <h3>{tool.name}</h3>
                    <p>{tool.description}</p>
                    <div className="tool-card-chips">
                      {tool.artifactTags.map((tag) => {
                        const chipClass = chipClassByTag[tag]
                        if (!chipClass) {
                          throw new Error(`未知产物标签: ${tag}`)
                        }
                        return (
                          <span key={tag} className={`artifact-chip ${chipClass}`}>
                            {tag}
                          </span>
                        )
                      })}
                    </div>
                  </div>
                </div>
              </article>
            )
          })}
        </div>

        {filteredTools.length === 0 && (
          <div className="empty-sessions-hint">未找到与 “{query}” 相关的工具</div>
        )}
      </div>
    </div>
  )
}
