import { useRef, useEffect, type FormEvent } from 'react'
import { ArrowRight, Search } from 'lucide-react'
import viralMaterialsIcon from '../../../../../../png/爆款素材获取.png'
import preciseSrtIcon from '../../../../../../png/精准 SRT 对齐.png'
import videoDownloaderIcon from '../../../../../../png/downloder.png'
import videoAudioIcon from '../../../../../../png/视频提取音频.png'
import vocalSeparationIcon from '../../../../../../png/人声分离.png'
import speechToTextIcon from '../../../../../../png/语音转文字.png'
import type { ToolManifest } from '@koubox/shared'
import { Input } from '@/components/ui/input'

type HomePageProps = {
  tools: ToolManifest[]
  query: string
  onQueryChange: (query: string) => void
  onOpenTool: (tool: ToolManifest) => void
}

const toolImages: Record<string, string> = {
  'viral-materials': viralMaterialsIcon,
  'precise-srt': preciseSrtIcon,
  'video-downloader': videoDownloaderIcon,
  'video-audio': videoAudioIcon,
  'vocal-separation': vocalSeparationIcon,
  'speech-to-text': speechToTextIcon
}

export function HomePage({ tools, query, onQueryChange, onOpenTool }: HomePageProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        inputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const filteredTools = tools.filter((tool) =>
    `${tool.name} ${tool.description}`.toLowerCase().includes(query.toLowerCase())
  )
  const handleFormSubmit = (event: FormEvent) => {
    event.preventDefault()
    if (filteredTools.length > 0) onOpenTool(filteredTools[0])
  }

  return (
    <section className="home-page">
      <div className="home-page__content">
        <header className="home-page__header">
          <div className="home-page__heading">
            <h1>工具箱</h1>
            <p>采集素材、处理音频、转写文字与制作字幕。</p>
          </div>
          <form className="home-search" onSubmit={handleFormSubmit}>
            <Search className="home-search__icon" size={17} strokeWidth={1.8} />
            <Input ref={inputRef} className="home-search__input" value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="搜索你的创作工具" aria-label="搜索工具" />
            <kbd className="home-search__shortcut">Ctrl K</kbd>
          </form>
        </header>


        <div className="studio-section-heading"><h2>{query ? '搜索结果' : '全部工具'} <span>{filteredTools.length.toString().padStart(2, '0')}</span></h2></div>
        {filteredTools.length === 0 ? (
          <div className="home-page__empty">未找到与“{query}”相关的工具</div>
        ) : (
          <div className="home-tool-grid">
            {filteredTools.map((tool) => {
              const image = toolImages[tool.id]
              return (
                <button key={tool.id} type="button" onClick={() => onOpenTool(tool)} className="home-tool-card" data-tool={tool.id} title={tool.description}>
                  <div className="home-tool-card__main">
                    <span className="home-tool-card__icon" aria-hidden="true"><img src={image} alt="" /></span>
                    <div className="home-tool-card__copy">
                      <div className="home-tool-card__title-row"><h2>{tool.name}</h2><span className="home-tool-card__arrow" aria-hidden="true"><ArrowRight size={16} strokeWidth={1.8} /></span></div>
                      <p>{tool.description}</p>
                    </div>
                  </div>
                  <div className="home-tool-card__tags">{tool.artifactTags.map((tag) => <span key={tag} className="home-tool-card__tag" data-kind={tag}>{tag}</span>)}</div>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
}
