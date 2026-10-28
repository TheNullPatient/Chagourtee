# Chagourtee v0.4.0-alpha Release Plan

This document outlines the planned features and improvements for the upcoming v0.4.0-alpha release of Chagourtee.

## Overview

The v0.4.0-alpha release will focus on enhancing file handling capabilities, redesigning the UI, extending permission management, improving user interactions, adding new room types, and implementing secure connections.

## Feature Categories & Implementation Plan

### 1. Enhanced File Handling

#### 1.1. Improved Media Size Validation
- [x] Implement client-side validation for media file sizes before upload in [Chat.tsx](./client/src/pages/Chat.tsx)
- [x] Show user-friendly warning when media exceeds the allowed size in the UI
- [x] Display the maximum allowed file size in the UI
- [x] Add error handling for file size limit exceeded scenarios in the upload process
- [x] Update the [media.ts](./client/src/api.ts#L134-L157) API to handle size validation errors

#### 1.2. Configurable Media Settings
- [x] Implement logic to disable media upload when CHAGOURTEE_MAX_FILE_SIZE is 0 in [media.js](./server/src/media.js)
- [x] Add support for unlimited media size when CHAGOURTEE_MAX_FILE_SIZE is -1
- [x] Create UI indicators to show whether media upload is disabled/enabled/unlimited
- [x] Update server-side validation in [media.js](./server/src/media.js) to respect the new configuration values

#### 1.3. Media Storage Quota Management
- [x] Add new environment variable CHAGOURTEE_MAX_STORAGE_SIZE for total storage limit
- [x] Implement server-side logic to track cumulative media storage in [media.js](./server/src/media.js)
- [x] Add cleanup strategy: either block new uploads or automatically delete oldest files
- [x] Create admin panel controls for managing storage settings
- [x] Implement automatic cleanup of oldest files when quota is exceeded (based on config)

#### 1.4. Missing Media Handling
- [x] Implement client-side detection for deleted media files in [MarkdownMessage.tsx](./client/src/components/MarkdownMessage.tsx)
- [x] Show "Media Removed" placeholder for missing media in messages
- [x] Create a consistent UI component for missing media placeholders
- [x] Add fallback styling for missing media elements

#### 1.5. Media Cleanup Routine
- [x] Implement periodic cleanup of orphaned media files (not linked to any message) in [media.js](./server/src/media.js)
- [x] Create scheduled task to run cleanup at configurable intervals
- [x] Add logging for cleanup operations
- [x] Implement safety checks to prevent accidental deletion of active media

### 2. UI Redesign

#### 2.1. Visual Overhaul
- [x] Update [client/src/index.css](./client/src/index.css) with more modern aesthetic (CSS variables, gradients, shadows, radii)
- [x] Make sure that all styles placed only in [client/src/index.css](./client/src/index.css) (inline styles not allowed) — only SyntaxHighlighter style remains (library-specific)
- [x] Add more animations and transitions (also between layouts like desktop/tablet/mobile) — 57+ transitions/animations, `--layout-transition` for layout changes
- [x] Replace Unicode emojis with SVG equivalents — all icons are SVG components from [Icons.tsx](./client/src/components/icons/Icons.tsx)
- [x] Create reusable CSS components with the new design (`.card`, `.btn-align-start`, `.form-stack`, `.theme-toggle-btn`, etc.)

#### 2.2. Settings Redesign
- [x] Combine profile and client settings into a unified Settings tab (profile, appearance, media sections)
- [x] Maintain separate Server Settings tab for server administration (Admin page for owner/moderator)
- [x] Implement categorized settings with side panel navigation (desktop sidebar, tablet bottom nav, mobile slide panel)
- [x] Add profile management section within settings (logout, verification status, password change, login change)
- [x] Create audio/video settings section (for future voice chat) — placeholder with mic, camera, volume controls
- [x] Add visual theme settings (auto/light/dark mode toggle) — three-button toggle with SVG icons

#### 2.3. New Page Implementation (1) — 403 Forbidden
- [x] Create 403 Forbidden page component ([Forbidden.tsx](./client/src/pages/Forbidden.tsx))
- [x] Add routing for unauthorized access scenarios in [App.tsx](./client/src/App.tsx)
- [x] Design error message with helpful guidance
- [x] Link to relevant help resources from the 403 page

#### 2.4. New Page Implementation (2) — Offline / Connection Error Page
- [x] Offline/connection error page implemented as [ConnectionError.tsx](./client/src/pages/ConnectionError.tsx)
- [x] Add routing for server offline scenarios in [App.tsx](./client/src/App.tsx) (`/connection-error`)
- [x] Design offline message with guidance on reconnection — реализовано в `ConnectionError.tsx` (причины: `network_unreachable`, `server_unavailable`, `timeout`, `websocket_error`; кнопки «Попробовать снова» и «На страницу входа»; список рекомендаций)
- [x] Link to relevant help resources from the offline page — ссылки на документацию и баг-трекер через `helpLinks`

### 3. Code Quality Improvements

#### 3.1. Replace Alert/Confirm Boxes with Custom Elements
- [x] Identify all instances of `alert()` in the client codebase (7 instances found in [Chat.tsx](./client/src/pages/Chat.tsx): lines 1070, 1392, 1642, 1685, 1732, 1794, 1835)
- [x] Identify all instances of `confirm()` in the client codebase (8 instances: [Chat.tsx](./client/src/pages/Chat.tsx) lines 1626, 1783; [Admin.tsx](./client/src/pages/Admin.tsx) lines 487, 503, 534, 682, 1180; [Settings.tsx](./client/src/pages/Settings.tsx) line 107)
- [x] Create custom toast/notification components to replace alerts (ToastContext and Toast component already exist)
- [x] Implement custom modal dialogs for confirmations (replacing `confirm()`)
- [x] Update all client components to use custom elements instead of native dialogs
- [x] Add proper error handling UI in place of alerts

#### 3.2. Centralize All Styling
- [x] Audit all inline styles throughout the application
- [x] Move all inline styles to the CSS files
- [x] Create CSS classes for commonly used style patterns
- [x] Ensure no component has inline styles after migration
- [x] Organize CSS in a modular, maintainable way

#### 3.3. Identified Styling Issues
- [x] Fix inline style usage in [MarkdownMessage.tsx](./client/src/components/MarkdownMessage.tsx) where `style={oneDark as any}` is used for syntax highlighting — `oneDark` удалён, SyntaxHighlighter использует `style={{}}`
- [x] Replace inline styles with CSS classes for the SyntaxHighlighter component
- [x] Create consistent styling for code blocks throughout the application — oneDark-палитра реализована через CSS-классы `.token.*` в [markdown.css](./client/src/styles/markdown.css), SyntaxHighlighter использует `style={{}}` без встроенной темы

#### 3.4. CSS Code Quality Issues
- [x] Fix duplicate `@keyframes pulse` definition in [index.css](./client/src/index.css)
- [x] Fix invalid CSS function: `linear(...)` → `linear-gradient(...)` in [index.css](./client/src/index.css)
- [x] Remove duplicate `height: 100dvh` declarations in [index.css](./client/src/index.css)
- [x] Consolidate duplicated responsive rules for `.layout-nav-bottom` and `.layout-header-top` (merged `@media (max-width: 678px)` and `@media (min-width: 678px) and (max-width: 876px)` into single `@media (max-width: 876px)`)
- [x] Remove dead server-info hiding rules (targeted non-existent classes; Layout.tsx handles this via JS)
- [x] Consider splitting monolithic [index.css](./client/src/index.css) into modular CSS files — CSS разбит на модули в [client/src/styles/](./client/src/styles/) (chat.css, admin.css, auth.css и др.), index.css импортирует их

#### 3.5. Duplicate version.ts in Server Source
- [x] Remove unused [version.ts](./server/src/version.ts) (duplicate of [version.js](./server/src/version.js))

### 4. Extended Permission Management

#### 4.1. Granular Moderator Permissions
- [ ] Add database schema for granular permissions
- [ ] Implement owner-only interface to assign permissions to moderators
- [ ] Create permission types: create_rooms, delete_rooms, edit_rooms, manage_users, manage_permissions
- [ ] Add API endpoints for managing user permissions in [users.js](./server/src/users.js)
- [ ] Implement permission checks throughout the application
- [ ] Create UI for owners to modify individual moderator permissions

#### 4.2. Room Access Levels
- [x] Define four room access levels: Public, Closed (password), Private (hidden), Restricted (whitelist)
- [x] Add database fields to store room access level and related settings
- [x] Implement server-side access control for each room type in [rooms.js](./server/src/rooms.js)
- [x] Create UI controls for room creators/administrators to set access levels
- [x] Add password protection for closed rooms
- [x] Implement whitelist management for restricted rooms
- [x] Hide private/restricted rooms from room listings appropriately

### 5. Enhanced User Interactions

#### 5.1. Message Replies
- [x] Add reply functionality to message context menu in [Chat.tsx](./client/src/pages/Chat.tsx)
- [x] Implement quoted message display in replies
- [x] Add automatic ping/mention to replied-to user
- [x] Create visual hierarchy for reply chains
- [x] Implement scroll-to-original-message functionality when clicking quotes

#### 5.2. Mention Notifications
- [ ] Add indicator for unseen mentions when scrolled down
- [ ] Create scroll-to-mention button positioned above the "scroll to bottom" button
- [ ] Implement mention tracking and notification logic
- [ ] Add visual indication of unread mentions
- [ ] Remove mention notification after scrolling to or clicking on the button

#### 5.3. Message Reactions
- [ ] Implement reaction system allowing customizable emojis per room
- [ ] Add reaction buttons appearing above the message input
- [ ] Create UI for displaying reactions under messages
- [ ] Add indicator for unseen reactions when scrolled down
- [ ] Implement scroll-to-reaction button positioned above the "scroll to bottom" button
- [ ] Add API endpoints for managing reactions in [messages.js](./server/src/messages.js)

### 6. New Room Types

#### 6.1. Room Type Implementation
- [ ] Add Text (standard), Channel (owners/moderators only), Voice (audio communication) room types
- [ ] Modify database schema to support room types
- [ ] Implement access controls based on room type
- [ ] Create UI indicators for room types

#### 6.2. Channel-Specific Features
- [ ] Hide user list button in channel rooms
- [ ] Restrict message posting to owners and authorized moderators
- [ ] Add visual indicators for channel rooms

#### 6.3. Voice Room Features
- [ ] Add user list with call invitation buttons
- [ ] Implement modal for incoming voice calls
- [ ] Add sound notifications for call invitations
- [ ] Create UI for managing microphone, camera, and volume settings
- [ ] Integrate WebRTC for voice communication
- [ ] Implement call accept/decline functionality

### 7. HTTPS/WSS and Tunneling

#### 7.1. Secure Connections
- [ ] Add SECURE_CONNECTION environment variable support in [index.js](./server/src/index.js)
- [ ] Implement HTTPS server alongside HTTP server
- [ ] Redirect HTTP traffic to HTTPS when SECURE_CONNECTION=true
- [ ] Implement WSS instead of WS when HTTPS is enabled in [websocket.ts](./client/src/websocket.ts)
- [ ] Add certificate and key path configuration in .env

#### 7.2. Cloudflare Tunnel Support
- [ ] Add built-in support for Cloudflare Tunnel
- [ ] Implement automatic certificate generation for HTTPS/WSS
- [ ] Add documentation for setting up with DuckDNS or similar services
- [ ] Create setup wizard for tunnel configuration

## Implementation Priority

### High Priority (Required for v0.4.0-alpha)
1. Enhanced File Handling (especially media size validation and error handling) — ✅ **Done**
2. Code Quality Improvements (replace alerts and centralize styles) — ✅ **Done** (alerts и confirm заменены на Toast/ConfirmModal, CSS разбит на модули)
3. Basic HTTPS/WSS implementation
4. Message Replies functionality — ✅ **Done**
5. Room access levels (at least basic implementation) — ✅ **Done** (Public / Closed / Private / Restricted)

### Medium Priority (Would be nice for v0.4.0-alpha)
1. Extended Permission Management
2. Mention Notifications
3. Message Reactions

### Low Priority (Consider for future releases)
1. Voice Room Features (complex implementation)
2. Full Cloudflare Tunnel integration

## Security Considerations
- [ ] Ensure all new features follow security best practices
- [ ] Review authentication/authorization for new API endpoints
- [ ] Validate all user inputs to prevent injection attacks
- [ ] Ensure proper encryption for file uploads and storage
- [ ] Secure WebSocket connections with proper authentication

## Identified Styling Issues (Client-Side) — Audit Report

### Fixed
- ~~Invalid CSS function `linear(...)`~~ → fixed to `linear-gradient(...)`
- ~~Duplicate `@keyframes pulse`~~ → removed duplicate
- ~~Duplicate `height: 100dvh`~~ → removed 3 redundant duplicates
- ~~Duplicated responsive rules for `.layout-nav-bottom`/`.layout-header-top`~~ → consolidated into single `@media (max-width: 876px)`
- ~~Overly broad `!important` in server-info hiding rules~~ → removed dead CSS (targeted non-existent classes)

### Remaining
- ~~**SyntaxHighlighter theme**~~ — oneDark-палитра реализована через CSS-классы `.token.*` в [markdown.css](./client/src/styles/markdown.css) — ✅ Done
- ~~**Offline page**~~ — реализовано как `ConnectionError.tsx` — ✅ Done

### Other Observations
- **Inline styles**: В [MarkdownMessage.tsx](./client/src/components/MarkdownMessage.tsx) `oneDark` удалён — `style={{}}` передаётся в SyntaxHighlighter
- **alert() calls**: Все заменены на Toast — ✅ Done
- **confirm() calls**: Все заменены на ConfirmModal — ✅ Done
- **No CSS linting**: No Stylelint or autoprefixer configured
- **Emoji usage**: No Unicode emojis found in client code (all icons use SVG components from [Icons.tsx](./client/src/components/icons/Icons.tsx)) — ✅ Done

## Testing Requirements
- [ ] Unit tests for new server functionality
- [ ] Integration tests for permission systems
- [ ] UI tests for new client features
- [ ] Load testing for file upload functionality
- [ ] Security testing for permission boundaries
- [ ] Compatibility testing for HTTPS/WSS implementation