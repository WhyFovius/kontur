import { useEffect, useState, type RefObject } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { Theme } from "../theme";
import { springSnappy, springEmphasized, springFollow } from "../motion";
import { useDragSelect } from "./useDragSelect";
import { AezaLogo, BrandPattern } from "./Brand";
import {
  IconCheck,
  IconChevron,
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
    // Google's own toggle icon-button: the sun/moon swap is the
    // component's built-in selected-slot mechanism, no custom
    // animation code left to glitch.
    <md-icon-button
      toggle
      selected={isDark}
      class={`theme-toggle-md ${className}`}
      onClick={onToggle}
      aria-label={
        isDark
          ? "Тёмная тема включена. Переключить на светлую тему"
          : "Светлая тема. Переключить на тёмную тему"
      }
      title={isDark ? "Переключить на светлую тему" : "Переключить на тёмную тему"}
    >
      <span className="md-icon-wrap">
        <IconSun />
      </span>
      <span slot="selected" className="md-icon-wrap">
        <IconMoon />
      </span>
    </md-icon-button>
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
  collapsed: boolean;
  onToggleSidebar: () => void;
}

export function Sidebar({
  activeSection,
  onNavigate,
  customerCount,
  username,
  connectionError,
  onLogout,
  collapsed,
  onToggleSidebar,
}: SidebarProps) {
  const drag = useDragSelect<SectionId>({
    values: NAV_IDS,
    selected: activeSection,
    axis: "y",
    onCommit: (value) => onNavigate(value),
  });

  return (
    <aside className="sidebar">
      <a href="#overview" className="brand-lockup" aria-label="Aéza Контур — к обзору">
        <span className="brand-logo-full">
          <AezaLogo />
        </span>
        <span className="brand-logo-compact">
          <AezaLogo compact />
        </span>
        <span className="brand-product">
          <strong>Контур</strong>
          <small>удержание клиентов</small>
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
              title={collapsed ? item.label : undefined}
              onClick={(event) => drag.handleItemClick(item.id, event)}
            >
              <motion.span
                className="nav-icon"
                initial={false}
                animate={{ scale: active ? 1 : 0.94, rotate: active ? 0 : -3 }}
                transition={springSnappy}
                aria-hidden="true"
              >
                <Icon />
              </motion.span>
              <span className="nav-label">{item.label}</span>
              {item.id === "customers" && <span className="nav-count">{customerCount}</span>}
            </a>
          );
        })}
      </nav>

      <div className="sidebar-bottom">
        <motion.button
          type="button"
          className="sidebar-toggle"
          onClick={onToggleSidebar}
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Развернуть панель навигации" : "Свернуть панель навигации"}
          title={collapsed ? "Развернуть панель навигации" : "Свернуть панель навигации"}
          whileTap={{ scale: 0.94 }}
          transition={springSnappy}
        >
          <motion.span
            className="sidebar-toggle-icon"
            initial={false}
            animate={{ rotate: collapsed ? -90 : 90 }}
            transition={springSnappy}
            aria-hidden="true"
          >
            <IconChevron />
          </motion.span>
          <span className="sidebar-toggle-label">{collapsed ? "Развернуть" : "Свернуть"}</span>
        </motion.button>
        <div className="sidebar-note">
          <BrandPattern className="sidebar-pattern" />
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
          <md-icon-button onClick={onLogout} aria-label="Выйти из аккаунта" title="Выйти">
            <span className="md-icon-wrap">
              <IconLogout />
            </span>
          </md-icon-button>
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
            <motion.span
              className="mobile-nav-icon-wrap"
              initial={false}
              animate={{ scale: active ? 1 : 0.92, rotate: active ? 0 : -3 }}
              transition={springSnappy}
            >
              <Icon />
            </motion.span>
            <span>{item.label}</span>
          </a>
        );
      })}
    </nav>
  );
}

/* ---------------- Top app bar ---------------- */

function UpdatedAgo({ at }: { at: number | null }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!at) return undefined;
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [at]);
  if (!at) return <span className="updated-time">только что</span>;
  const sec = Math.max(0, Math.round((Date.now() - at) / 1000));
  const label =
    sec < 5
      ? "только что"
      : sec < 60
        ? `${sec} с назад`
        : sec < 3600
          ? `${Math.floor(sec / 60)} мин назад`
          : new Date(at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  return (
    <span
      className="updated-time"
      title={`Обновлено в ${new Date(at).toLocaleTimeString("ru-RU")}`}
    >
      {label}
    </span>
  );
}

interface TopbarProps {
  sectionLabel: string;
  theme: Theme;
  onToggleTheme: () => void;
  connectionError: boolean;
  lastUpdatedAt: number | null;
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
  lastUpdatedAt,
  uploadPhase,
  onUploadClick,
  fileInputRef,
  onFileSelected,
  onLogout,
}: TopbarProps) {
  const uploading = uploadPhase === "loading";
  return (
    <header className="topbar">
      <nav className="breadcrumbs" aria-label="Хлебные крошки">
        <ol>
          <li className="crumb-brand">Aéza</li>
          <li className="crumb-separator" aria-hidden="true">/</li>
          <li>Контур</li>
          <li className="crumb-separator" aria-hidden="true">/</li>
          <li aria-current="page">
            <motion.strong
              key={sectionLabel}
              initial={{ opacity: 0, y: 7, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={springSnappy}
            >
              {sectionLabel}
            </motion.strong>
          </li>
        </ol>
      </nav>
      <div className="topbar-actions">
        <span
          className={`live-indicator sync-capsule${connectionError ? " is-error" : ""}`}
          role="status"
        >
          <span className="sync-dot" aria-hidden="true">
            <motion.i
              key={lastUpdatedAt ?? "init"}
              initial={{ scale: 1.7 }}
              animate={{ scale: 1 }}
              transition={springSnappy}
            />
          </span>
          <span className="sync-label">
            {connectionError ? "Нет связи с сервером" : "Синхронизация активна"}
          </span>
          <span className="sync-divider" aria-hidden="true" />
          <UpdatedAgo at={lastUpdatedAt} />
        </span>
        <ThemeToggle theme={theme} onToggle={onToggleTheme} />
        <md-filled-button
          class={`upload-button upload-${uploadPhase}`}
          onClick={onUploadClick}
          disabled={uploading}
          aria-busy={uploading}
          aria-label={
            uploadPhase === "success"
              ? "Снимок обновлён. Загрузить ещё один снимок"
              : uploading
                ? "Идёт загрузка снимка"
                : "Загрузить снимок"
          }
          aria-describedby="snapshotHelp"
        >
          <span className="upload-label-wrap upload-label-stack" aria-hidden="true">
            <span className="upload-label-sizer">
              <IconUpload /> Загрузить снимок
            </span>
            <motion.span
              className="upload-label-layer"
              initial={false}
              animate={
                uploadPhase === "idle"
                  ? { opacity: 1, y: 0, scale: 1 }
                  : { opacity: 0, y: 6, scale: 0.92 }
              }
              transition={springSnappy}
            >
              <IconUpload /> Загрузить снимок
            </motion.span>
            <motion.span
              className="upload-label-layer"
              initial={false}
              animate={
                uploading
                  ? { opacity: 1, y: 0, scale: 1 }
                  : { opacity: 0, y: 6, scale: 0.92 }
              }
              transition={springSnappy}
            >
              <span className="button-spinner" aria-hidden="true" /> Загружаем…
            </motion.span>
            <motion.span
              className="upload-label-layer"
              initial={false}
              animate={
                uploadPhase === "success"
                  ? { opacity: 1, y: 0, scale: 1 }
                  : { opacity: 0, y: 6, scale: 0.92 }
              }
              transition={springSnappy}
            >
              <IconCheck /> Снимок обновлён
            </motion.span>
          </span>
        </md-filled-button>
        <md-icon-button
          class="mobile-logout"
          onClick={onLogout}
          aria-label="Выйти из аккаунта"
          title="Выйти"
        >
          <span className="md-icon-wrap">
            <IconLogout />
          </span>
        </md-icon-button>
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
            <md-icon-button class="snackbar-close-md" onClick={onClose} aria-label="Закрыть сообщение">
              <span className="md-icon-wrap">
                <IconClose />
              </span>
            </md-icon-button>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
