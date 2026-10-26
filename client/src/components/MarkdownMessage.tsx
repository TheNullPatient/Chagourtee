import React, { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeSanitize from 'rehype-sanitize';
import rehypeKatex from 'rehype-katex';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import type { MediaFile } from '../api';
import AudioPlayer from './AudioPlayer';
import VideoPlayer from './VideoPlayer';
import MediaViewer from './MediaViewer';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import {
  addMessageHandler,
  removeMessageHandler,
  getWebSocket,
  addOpenHandler,
  removeOpenHandler,
} from '../websocket';

// Импортируем KaTeX CSS
import 'katex/dist/katex.min.css';

interface MarkdownMessageProps {
  content: string;
  media?: MediaFile[];
  mediaPosition?: 'above' | 'below';
}

const MarkdownMessage: React.FC<MarkdownMessageProps> = React.memo(
  ({ content, media, mediaPosition = 'below' }) => {
    const [viewerState, setViewerState] = useState<{
      file: MediaFile;
      mode: 'image' | 'video';
    } | null>(null);
    const [missingMediaIds, setMissingMediaIds] = useState<Set<number>>(new Set());

    useEffect(() => {
      if (!media || media.length === 0) {
        return;
      }

      const requestId = `media-check-${Date.now()}-${Math.random()}`;
      const sendAvailabilityCheck = () => {
        const ws = getWebSocket();
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        ws.send(
          JSON.stringify({
            type: 'check_media_availability',
            requestId,
            files: media.map((m) => ({ id: m.id, encrypted_filename: m.encrypted_filename })),
          })
        );
      };

      const handleWsMessage = (payload: any) => {
        if (
          payload.type === 'media_availability_result' &&
          payload.requestId === requestId &&
          Array.isArray(payload.unavailableIds)
        ) {
          setMissingMediaIds(new Set(payload.unavailableIds.map((id: number) => Number(id))));
        }
        if (payload.type === 'media_removed' && typeof payload.mediaId === 'number') {
          setMissingMediaIds((prev) => {
            const next = new Set(prev);
            next.add(payload.mediaId);
            return next;
          });
        }
      };

      addMessageHandler(handleWsMessage);
      addOpenHandler(sendAvailabilityCheck);
      sendAvailabilityCheck();

      return () => {
        removeMessageHandler(handleWsMessage);
        removeOpenHandler(sendAvailabilityCheck);
      };
    }, [media]);

    const mediaWithStatus = useMemo(() => {
      if (!media) return [];
      return media.map((mediaFile) => ({
        mediaFile,
        isMissing: missingMediaIds.has(mediaFile.id),
      }));
    }, [media, missingMediaIds]);

    const markMediaMissing = (id: number) => {
      setMissingMediaIds((prev) => {
        if (prev.has(id)) return prev;
        const next = new Set(prev);
        next.add(id);
        return next;
      });
    };
    const markdownElement = (
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeSanitize, rehypeKatex]}
        components={{
          code({ node, className, children, ...props }: any) {
            const hasLang = /language-(\w+)/.exec(className || '');
            
            // Если это инлайновый код, просто возвращаем стандартный элемент
            if (!hasLang) {
              return (
                <code className={className} {...props}>
                  {children}
                </code>
              );
            }

            // Это блок кода с указанным языком
            const lang = hasLang[1];
            // Извлекаем фактический код, убирая лишние пробелы
            const codeString = String(children).replace(/\n$/, '');
            
            return (
              <div className="code-block-wrapper">
                <div className="code-header">
                  <span className="code-language">{lang}</span>
                </div>
                <div className="syntax-highlighter-inner">
                <SyntaxHighlighter style={oneDark as any} language={lang} PreTag="div" {...props}>
                    {codeString}
                  </SyntaxHighlighter>
                </div>
              </div>
            );
          },
          // Обработка ссылок для обеспечения безопасности
          a: ({ node, className, href, children, ...props }) => {
            // Проверяем, является ли ссылка абсолютной (внешней)
            const isExternal = href && (href.startsWith('http://') || href.startsWith('https://'));
            
            return (
              <a
                href={href}
                className={[className, 'md-a'].filter(Boolean).join(' ')}
                target={isExternal ? '_blank' : undefined}
                rel={isExternal ? 'noopener noreferrer' : undefined}
                {...props}
              >
                {children}
              </a>
            );
          },
          p: ({ node, ...props }) => <p className="md-p" {...props} />,
          li: ({ node, ...props }) => <li className="md-li" {...props} />,
          blockquote: ({ node, ...props }) => <blockquote className="md-blockquote" {...props} />,
          table: ({ node, ...props }) => (
            <div className="md-table-scroll">
              <table className="md-table" {...props} />
            </div>
          ),
          img: ({ node, ...props }) => <img className="md-img" {...props} />,
          div: ({ node, ...props }) => <div className="md-div" {...props} />,
          span: ({ node, ...props }) => <span className="md-span" {...props} />
        }}
      >
        {content}
      </ReactMarkdown>
    );

    const mediaElement =
      media && media.length > 0 ? (
        <div className="media-container media-container-spaced">
          {mediaWithStatus.map(({ mediaFile, isMissing }) => {
            const isImage = mediaFile.mime_type.startsWith('image/');
            const isVideo = mediaFile.mime_type.startsWith('video/');
            const isAudio = mediaFile.mime_type.startsWith('audio/');

            return (
              <div key={mediaFile.id} className="media-item media-item-spaced">
                {isMissing ? (
                  <div className="media-removed-placeholder" title={mediaFile.original_name}>
                    <div className="media-removed-title">Media Removed</div>
                    <div className="media-removed-subtitle">{mediaFile.original_name}</div>
                  </div>
                ) : isImage ? (
                  <img
                    src={`/api/media/${mediaFile.encrypted_filename}`}
                    alt={mediaFile.original_name}
                    className="md-img md-img-clickable"
                    onClick={() =>
                      setViewerState({ file: mediaFile, mode: 'image' })
                    }
                    onError={() => markMediaMissing(mediaFile.id)}
                  />
                ) : isVideo ? (
                  <VideoPlayer
                    file={mediaFile}
                    onOpenFullscreen={() =>
                      setViewerState({ file: mediaFile, mode: 'video' })
                    }
                    onError={() => markMediaMissing(mediaFile.id)}
                  />

                ) : isAudio ? (
                  <AudioPlayer file={mediaFile} onError={() => markMediaMissing(mediaFile.id)} />
                ) : (
                  <div className="document-banner">
                    <div className="document-banner-header">
                      <div className="document-icon">
                        <svg
                          width="20"
                          height="20"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"></path>
                          <polyline points="14 2 14 8 20 8"></polyline>
                        </svg>
                      </div>
                      <div className="document-info">
                        <div className="document-name" title={mediaFile.original_name}>
                          {mediaFile.original_name}
                        </div>
                        <div className="document-meta">
                          {(mediaFile.file_size / 1024).toFixed(1)} KB •{' '}
                          {mediaFile.mime_type.split('/')[1] || mediaFile.mime_type}
                        </div>
                      </div>
                    </div>
                    <div className="document-actions">
                      <a
                        href={`/api/media/${mediaFile.encrypted_filename}`}
                        download={mediaFile.original_name}
                        className="download-button"
                        onClick={(e) => {
                          e.preventDefault();
                          fetch(`/api/media/${mediaFile.encrypted_filename}`, {
                            method: 'GET',
                            headers: { Range: 'bytes=0-0' },
                            credentials: 'include',
                          })
                            .then((res) => {
                              if (res.status === 404) {
                                markMediaMissing(mediaFile.id);
                                return;
                              }
                              window.open(`/api/media/${mediaFile.encrypted_filename}`, '_blank');
                            })
                            .catch(() => {
                              markMediaMissing(mediaFile.id);
                            });
                        }}
                      >
                        <svg
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                          <polyline points="7 10 12 15 17 10"></polyline>
                          <line x1="12" y1="15" x2="12" y2="3"></line>
                        </svg>
                        Скачать
                      </a>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : null;

    return (
      <div className="markdown-container">
        {mediaPosition === 'above' && mediaElement}
        {markdownElement}
        {mediaPosition !== 'above' && mediaElement}
        {viewerState && (
          <MediaViewer
            file={viewerState.file}
            mode={viewerState.mode}
            onClose={() => setViewerState(null)}
          />
        )}
      </div>
    );
  }
);

export default MarkdownMessage;