import type { RefObject } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { Theme } from "../theme";
import { springSnappy, springEmphasized, springFollow } from "../motion";
import { useDragSelect } from "./useDragSelect";
import {
  IconCheck,
  IconClose,
  IconGrid,
  IconLogout,
  IconMoon,
  IconSliders,
  IconSun,
  IconUpload,
  IconUsers,
} from "../icons";

export type SectionId = "overview" | "customers" | "model";
export type UploadPhase = "idle" | "loading" | "success";

const NAV_ITEMS: { id: SectionId; label: string; icon: typeof IconGrid }[] = [
  { id: "overview", label: "Обзор", icon: IconGrid },
  { id: "customers", label: "Клиенты", icon: IconUsers },
  { id: "model", label: "Модель риска", icon: IconSliders },
];
const NAV_IDS = NAV_ITEMS.map((item) => item.id);

/* ---------------- Theme toggle: sun <-> moon morph ---------------- */

export function ThemeToggle({
  theme,
  onToggle,
  className = "",
}: {
  theme: Theme;
  onToggle: () => void;
  className?: string;
}) {
  const isDark = theme === "dark";
  return (
    <motion.button
      type="button"
      className={`icon-button theme-toggle ${className}`}
      onClick={onToggle}
      aria-label={isDark ? "Переключить на светлую тему" : "Переключить на тёмную тему"}
      aria-pressed={isDark}
      title={isDark ? "Переключить на светлую тему" : "Переключить на тёмную тему"}
      whileTap={{ scale: 0.88 }}
      transition={springSnappy}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={theme}
          className="theme-icon-swap"
          initial={{ opacity: 0, rotate: -35, scale: 0.65 }}
          animate={{ opacity: 1, rotate: 0, scale: 1 }}
          exit={{ opacity: 0, rotate: 35, scale: 0.65 }}
          transition={springSnappy}
          aria-hidden="true"
        >
          {isDark ? <IconSun /> : <IconMoon />}
        </motion.span>
      </AnimatePresence>
    </motion.button>
  );
}

/* ---------------- Sidebar / navigation drawer ---------------- */

interface SidebarProps {
  activeSection: SectionId;
  onNavigate: (section: SectionId) => void;
  customerCount: string;
  username: string;
  connectionError: boolean;
  onLogout: () => void;
}

export function Sidebar({
  activeSection,
  onNavigate,
  customerCount,
  username,
  connectionError,
  onLogout,
}: SidebarProps) {
  const drag = useDragSelect<SectionId>({
    values: NAV_IDS,
    selected: activeSection,
    axis: "y",
    onCommit: (value) => onNavigate(value),
  });

  return (
    <aside className="sidebar">
      <a href="#overview" className="brand-lockup" aria-label="Контур — к обзору">
        <span className="brand-mark" aria-hidden="true">
          <motion.span
            initial={{ scaleY: 0 }}
            animate={{ scaleY: 0.45 }}
            transition={{ ...springEmphasized, delay: 0.1 }}
          />
          <motion.span
            initial={{ scaleY: 0 }}
            animate={{ scaleY: 0.8 }}
            transition={{ ...springEmphasized, delay: 0.18 }}
          />
          <motion.span
            initial={{ scaleY: 0 }}
            animate={{ scaleY: 1 }}
            transition={{ ...springEmphasized, delay: 0.26 }}
          />
        </span>
        <span className="brand-name">
          контур<span> / удержание</span>
        </span>
      </a>

      <div className="workspace-label">Рабочее пространство</div>
      <nav
        className="workspace-nav drag-select"
        aria-label="Разделы рабочего пространства. Можно зажать и вести указатель."
        ref={drag.containerRef}
        data-dragging={drag.dragging || undefined}
        {...drag.containerHandlers}
      >
        {drag.thumbRect && (
          <motion.span
            className="nav-pill drag-thumb"
            aria-hidden="true"
            initial={false}
            animate={{
              x: drag.thumbRect.x,
              y: drag.thumbRect.y,
              width: drag.thumbRect.w,
              height: drag.thumbRect.h,
              opacity: drag.active ? 1 : 0,
            }}
            transition={springFollow}
          />
        )}
        {NAV_ITEMS.map((item) => {
          const active = drag.active === item.id;
          const Icon = item.icon;
          return (
            <a
              key={item.id}
              ref={drag.registerItem(item.id)}
              className={`nav-item${active ? " is-active" : ""}`}
              href={`#${item.id}`}
              draggable={false}
              aria-current={activeSection === item.id ? "page" : undefined}
              onClick={(event) => drag.handleItemClick(item.id, event)}
            >
              <span className="nav-icon" aria-hidden="true">
                <Icon />
              </span>
              <span className="nav-label">{item.label}</span>
              {item.id === "customers" && <span className="nav-count">{customerCount}</span>}
            </a>
          );
        })}
      </nav>

      <div className="sidebar-bottom">
        <div className="sidebar-note">
          <span
            className={`note-signal${connectionError ? " is-error" : ""}`}
            aria-hidden="true"
          />
          <div>
            <strong>{connectionError ? "Сервер недоступен" : "Снимок синхронизирован"}</strong>
            <span>
              {connectionError
                ? "Показаны последние загруженные данные"
                : "Проверка каждые 10 сек."}
            </span>
          </div>
        </div>
        <div className="profile">
          <div className="avatar" aria-hidden="true">
            {(username?.[0] || "А").toUpperCase()}
          </div>
          <div className="profile-info">
            <strong>{username || "Аналитик"}</strong>
            <span>Команда маркетинга</span>
          </div>
          <motion.button
            type="button"
            className="icon-button"
            onClick={onLogout}
            aria-label="Выйти из аккаунта"
            title="Выйти"
            whileTap={{ scale: 0.9 }}
            transition={springSnappy}
          >
            <IconLogout />
          </motion.button>
        </div>
      </div>
    </aside>
  );
}

/* ---------------- Mobile bottom navigation ---------------- */

export function MobileNav({
  activeSection,
  onNavigate,
}: {
  activeSection: SectionId;
  onNavigate: (section: SectionId) => void;
}) {
  const drag = useDragSelect<SectionId>({
    values: NAV_IDS,
    selected: activeSection,
    axis: "x",
    allowTouch: true,
    onCommit: (value) => onNavigate(value),
  });

  return (
    <nav
      className="mobile-nav drag-select drag-select-touch-x"
      aria-label="Основная навигация. Можно зажать и вести палец."
      ref={drag.containerRef}
      data-dragging={drag.dragging || undefined}
      {...drag.containerHandlers}
    >
      {drag.thumbRect && (
        <motion.span
          className="mobile-nav-pill drag-thumb"
          aria-hidden="true"
          initial={false}
          animate={{
            x: drag.thumbRect.x,
            y: drag.thumbRect.y,
            width: drag.thumbRect.w,
            height: drag.thumbRect.h,
            opacity: drag.active ? 1 : 0,
          }}
          transition={springFollow}
        />
      )}
      {NAV_ITEMS.map((item) => {
        const active = drag.active === item.id;
        const Icon = item.icon;
        return (
          <a
            key={item.id}
            ref={drag.registerItem(item.id)}
            href={`#${item.id}`}
            draggable={false}
            className={`mobile-nav-item${active ? " is-active" : ""}`}
            aria-current={activeSection === item.id ? "page" : undefined}
            onClick={(event) => drag.handleItemClick(item.id, event)}
          >
            <span className="mobile-nav-icon-wrap">
              <Icon />
            </span>
            <span>{item.label}</span>
          </a>
        );
      })}
    </nav>
  );
}

/* ---------------- Top app bar ---------------- */

interface TopbarProps {
  sectionLabel: string;
  theme: Theme;
  onToggleTheme: () => void;
  connectionError: boolean;
  lastUpdated: string;
  uploadPhase: UploadPhase;
  onUploadClick: () => void;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onFileSelected: (file: File) => void;
  onLogout: () => void;
}

export function Topbar({
  sectionLabel,
  theme,
  onToggleTheme,
  connectionError,
  lastUpdated,
  uploadPhase,
  onUploadClick,
  fileInputRef,
  onFileSelected,
  onLogout,
}: TopbarProps) {
  const uploading = uploadPhase === "loading";
  return (
    <header className="topbar">
      <div className="breadcrumbs">
        <span>Контур</span>
        <span className="crumb-separator" aria-hidden="true">
          /
        </span>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.strong
            key={sectionLabel}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={springSnappy}
          >
            {sectionLabel}
          </motion.strong>
        </AnimatePresence>
      </div>
      <div className="topbar-actions">
        <span
          className={`live-indicator${connectionError ? " is-error" : ""}`}
          role="status"
        >
          <i aria-hidden="true" />
          <span>{connectionError ? "Нет связи с сервером" : "Синхронизация активна"}</span>
        </span>
        <span className="updated-time">{lastUpdated}</span>
        <ThemeToggle theme={theme} onToggle={onToggleTheme} />
        <motion.button
          type="button"
          className={`button button-primary upload-button upload-${uploadPhase}`}
          onClick={onUploadClick}
          disabled={uploading}
          aria-busy={uploading}
          aria-describedby="snapshotHelp"
          whileTap={{ scale: 0.97 }}
          transition={springSnappy}
        >
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={uploadPhase}
              className="upload-label-wrap"
              initial={{ opacity: 0, y: 8, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.95 }}
              transition={springSnappy}
            >
              {uploadPhase === "success" ? (
                <>
                  <IconCheck /> Снимок обновлён
                </>
              ) : uploading ? (
                <>
                  <span className="button-spinner" aria-hidden="true" /> Загружаем…
                </>
              ) : (
                <>
                  <IconUpload /> Загрузить снимок
                </>
              )}
            </motion.span>
          </AnimatePresence>
        </motion.button>
        <motion.button
          type="button"
          className="icon-button mobile-logout"
          onClick={onLogout}
          aria-label="Выйти из аккаунта"
          title="Выйти"
          whileTap={{ scale: 0.9 }}
          transition={springSnappy}
        >
          <IconLogout />
        </motion.button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onFileSelected(file);
            event.target.value = "";
          }}
        />
        <span id="snapshotHelp" className="sr-only">
          Загрузите файл JSON с аккаунтами, услугами и транзакциями. Можно также
          перетащить файл в окно.
        </span>
      </div>
    </header>
  );
}

/* ---------------- Snackbar ---------------- */

export interface ToastState {
  id: number;
  message: string;
  persistent: boolean;
}

export function Snackbar({
  toast,
  onClose,
}: {
  toast: ToastState | null;
  onClose: () => void;
}) {
  return (
    <AnimatePresence>
      {toast && (
        <motion.div
          key={toast.id}
          className="snackbar"
          role="status"
          aria-live="polite"
          initial={{ opacity: 0, y: 32, scale: 0.94 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 16, scale: 0.96 }}
          transition={springSnappy}
        >
          <span>{toast.message}</span>
          {toast.persistent && (
            <button
              type="button"
              className="snackbar-close"
              onClick={onClose}
              aria-label="Закрыть сообщение"
            >
              <IconClose />
            </button>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
