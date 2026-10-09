// dsh-kb — Client half.
//
// A focused three-column Obsidian-style workbench. The right column reuses the
// currently selected DSH Session, so the user can ask about the open note and
// save edits without leaving the desktop client.

import { EditorState, RangeSetBuilder } from "@codemirror/state";
import { EditorView, Decoration, ViewPlugin, WidgetType, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";

window.__ModuleLoader__.load({
  id: "dsh-kb",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    const API = "/api/dsh-kb";
    // 桌面壳（Electron + titleBarOverlay）在窗口顶部保留一段原生窗口控件区，页面在该区域收不到点击；
    // 覆盖层整体下移这段高度，避免顶栏按钮（尤其关闭键）落进死区。
    const TITLEBAR_INSET = (() => {
      try {
        const rect = navigator.windowControlsOverlay && navigator.windowControlsOverlay.getTitlebarAreaRect
          ? navigator.windowControlsOverlay.getTitlebarAreaRect()
          : null;
        if (rect && rect.height > 0) return Math.round(rect.height);
      } catch (error) { /* fall through to UA guess */ }
      return /electron/i.test(navigator.userAgent || "") ? 42 : 0;
    })();
    const css = [
      "._kb_button{box-sizing:border-box;width:36px;height:36px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font-size:19px;line-height:1;transition:background .15s ease,border-color .15s ease,transform .15s ease}",
      "._kb_button:hover{background:var(--dsw-alias-interactive-bg-hover-accent);transform:translateY(-1px)}",
      "._kb_button[data-active=true]{border-color:#7c65d7;background:color-mix(in srgb,#7c65d7 16%,var(--dsw-alias-bg-module-platform))}",
      // 侧边栏底部入口「知识中心」：宽态=整行图标+文字，rail 态=36×36 圆钮。
      // 样式对齐同槽位其它按钮（与 cardian 的 cardian-kt-trigger 一致）。
      "._kb_trigger{box-sizing:border-box;cursor:pointer;width:calc(100% + 8px);height:34px;color:var(--dsw-alias-label-primary);background:transparent;border:none;border-radius:12px;flex:none;align-items:center;gap:8px;margin:4px -4px;padding:6px 2px 6px 10px;font-family:inherit;font-size:14px;line-height:22px;display:flex;overflow:hidden;transition:background .12s,color .12s;outline:none}",
      "._kb_trigger:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      "._kb_trigger[data-on=true]{color:var(--dsw-alias-brand-primary-new-colorprimary-new-color);background:color-mix(in srgb,var(--dsw-alias-brand-primary-new-colorprimary-new-color) 10%,transparent)}",
      "._kb_trigger[data-rail=true]{border-radius:50%;justify-content:center;gap:0;width:36px;height:36px;margin:8px 0 10px;padding:0}",
      "._kb_trigger ._kb_obsidianicon{width:18px;height:18px;flex:none}",
      "._kb_obsidianicon{display:block;width:23px;height:23px;color:#7c65d7}",
      "._kb_overlay{position:fixed;inset:0;box-sizing:border-box;z-index:1500;min-width:0;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);display:grid;grid-template-columns:280px 1px minmax(360px,1fr) 1px 360px;overflow:hidden;font-family:var(--ds-font-family,Inter,system-ui,sans-serif)}",
      "._kb_left,._kb_center,._kb_right{min-width:0;min-height:0;overflow:hidden}",
      "._kb_left{display:flex;flex-direction:column;background:color-mix(in srgb,#7c65d7 4%,var(--dsw-specific-sidebar-fill))}",
      "._kb_center{display:flex;flex-direction:column;background:var(--dsw-alias-bg-base)}",
      "._kb_right{display:flex;flex-direction:column;background:color-mix(in srgb,#7c65d7 3%,var(--dsw-alias-bg-base))}",
      "._kb_resize{position:relative;z-index:2;min-height:0;background:var(--dsw-alias-border-l2);cursor:col-resize;touch-action:none}",
      "._kb_resize::after{content:\"\";position:absolute;inset:0 -4px;cursor:col-resize}",
      "._kb_resize:hover,._kb_resize[data-dragging=true]{background:#7c65d7}",
      "._kb_topbar{height:58px;box-sizing:border-box;display:flex;align-items:center;gap:10px;padding:0 16px;border-bottom:1px solid var(--dsw-alias-border-l2);flex:none}",
      "._kb_vaultmark{width:30px;height:30px;border-radius:9px;background:color-mix(in srgb,#7c65d7 12%,transparent);color:#7c65d7;display:flex;align-items:center;justify-content:center;flex:none}",
      "._kb_vaultmark ._kb_obsidianicon{width:27px;height:27px}",
      "._kb_title{min-width:0;display:flex;flex-direction:column;gap:1px;flex:1}",
      "._kb_title strong{font-size:14px;line-height:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      "._kb_title span{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      "._kb_iconbtn{position:relative;width:30px;height:30px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:17px;line-height:1;display:inline-flex;align-items:center;justify-content:center;flex:none}",
      "._kb_iconbtn::after{content:\"\";position:absolute;inset:-8px}",
      "._kb_iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      "._kb_leftbody{min-width:0;min-height:0;flex:1;overflow:auto;overscroll-behavior:contain;padding:10px 8px 18px}",
      "._kb_sectionhead{display:flex;align-items:center;gap:5px;padding:4px 4px 6px 8px;color:var(--dsw-alias-label-tertiary)}",
      "._kb_sectionlabel{min-width:0;flex:1;font-size:11px;letter-spacing:.04em;text-transform:uppercase}",
      "._kb_searchbar{display:flex;align-items:center;gap:5px;margin:0 4px 8px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base)}",
      "._kb_searchbar:focus-within{border-color:#7c65d7;box-shadow:0 0 0 2px color-mix(in srgb,#7c65d7 12%,transparent)}",
      "._kb_searchinput{min-width:0;flex:1;height:29px;border:0;outline:0;background:transparent;color:var(--dsw-alias-label-primary);font:12px var(--ds-font-family,Inter,system-ui,sans-serif)}",
      "._kb_searchinput::placeholder{color:var(--dsw-alias-label-tertiary)}",
      "._kb_searchclear{border:0;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:15px;padding:0 2px}",
      "._kb_searchresult{width:100%;box-sizing:border-box;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);padding:7px 8px;text-align:left;cursor:pointer}",
      "._kb_searchresult:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      "._kb_searchname{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}",
      "._kb_searchpath{display:block;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:10px}",
      "._kb_searchexcerpt{display:block;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:10px}",
      "._kb_treeactions{display:flex;align-items:center;gap:2px}",
      "._kb_mini{width:25px;height:25px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:17px;line-height:1;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}",
      "._kb_mini:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      "._kb_movebar{display:flex;align-items:center;gap:7px;margin:0 4px 7px;padding:6px 8px;border:1px solid color-mix(in srgb,#7c65d7 24%,var(--dsw-alias-border-l2));border-radius:8px;background:color-mix(in srgb,#7c65d7 7%,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.35}",
      "._kb_movebar[data-dragging=true]{border-color:#7c65d7;background:color-mix(in srgb,#7c65d7 14%,var(--dsw-alias-bg-base))}",
      "._kb_moveinfo{min-width:0;flex:1;display:flex;flex-direction:column;gap:1px;overflow:hidden}",
      "._kb_moveinfo strong,._kb_moveinfo span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      "._kb_moveinfo strong{font-size:11px;font-weight:600;color:var(--dsw-alias-label-primary)}",
      "._kb_moveinfo span{font-size:10px;color:var(--dsw-alias-label-tertiary)}",
      "._kb_moveaction{border:0;background:transparent;color:#7c65d7;font-size:11px;cursor:pointer;white-space:nowrap;padding:2px 3px}",
      "._kb_moveaction:hover{text-decoration:underline}",
      "._kb_undobar{display:flex;align-items:center;gap:7px;margin:0 4px 7px;padding:6px 8px;border:1px solid color-mix(in srgb,#c48a25 30%,var(--dsw-alias-border-l2));border-radius:8px;background:color-mix(in srgb,#c48a25 8%,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-secondary);font-size:11px}",
      "._kb_undobar span{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      "._kb_undobutton{border:0;background:transparent;color:#c48a25;font-size:11px;cursor:pointer;padding:2px 3px;white-space:nowrap}",
      "._kb_undobutton:hover{text-decoration:underline}",
      "._kb_contextmenu{position:fixed;z-index:2000;min-width:190px;padding:5px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-base);box-shadow:0 12px 32px rgba(36,30,18,.18)}",
      "._kb_contextitem{display:flex;align-items:center;gap:9px;width:100%;box-sizing:border-box;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);padding:8px 10px;text-align:left;font-size:12px;cursor:pointer}",
      "._kb_contextitem:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      "._kb_contextitem[data-danger=true]{color:var(--dsw-alias-state-error-primary)}",
      "._kb_contextsep{height:1px;margin:5px 2px;background:var(--dsw-alias-border-l1)}",
      "._kb_dialogbackdrop{position:fixed;inset:0;z-index:2100;background:rgba(36,30,18,.18);display:flex;align-items:center;justify-content:center;padding:20px}",
      "._kb_dialog{width:min(340px,calc(100vw - 40px));box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-base);box-shadow:0 16px 44px rgba(36,30,18,.22);padding:16px}",
      "._kb_dialogtitle{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);margin-bottom:12px}",
      "._kb_dialogcopy{margin:-3px 0 2px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}",
      "._kb_dialoginput{box-sizing:border-box;width:100%;height:36px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);outline:0;padding:0 10px;font:13px var(--ds-font-family,Inter,system-ui,sans-serif)}",
      "._kb_dialoginput:focus{border-color:#7c65d7;box-shadow:0 0 0 2px color-mix(in srgb,#7c65d7 15%,transparent)}",
      "._kb_dialogactions{display:flex;justify-content:flex-end;gap:7px;margin-top:14px}",
      "._kb_dialogbutton{border:0;border-radius:7px;padding:7px 12px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer}",
      "._kb_dialogbutton[data-primary=true]{background:#7c65d7;color:white}",
      "._kb_dialogbutton[data-danger=true]{background:var(--dsw-alias-state-error-primary);color:white}",
      "._kb_treeentry{width:100%;box-sizing:border-box;border:0;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:7px;min-height:30px;padding:0 8px;display:flex;align-items:center;gap:7px;text-align:left;cursor:pointer;font-size:13px}",
      "._kb_treeentry:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      "._kb_treeentry[data-selected=true]{background:color-mix(in srgb,#7c65d7 15%,var(--dsw-alias-interactive-bg-hover));color:var(--dsw-alias-label-primary)}",
      "._kb_treeentry[data-moving=true]{background:color-mix(in srgb,#7c65d7 18%,var(--dsw-alias-interactive-bg-hover));color:var(--dsw-alias-label-primary)}",
      "._kb_treeentry[data-drop-target=true]{background:color-mix(in srgb,#7c65d7 18%,var(--dsw-alias-interactive-bg-hover));color:var(--dsw-alias-label-primary);box-shadow:inset 0 0 0 1px color-mix(in srgb,#7c65d7 70%,transparent)}",
      "._kb_treearrow{width:12px;color:var(--dsw-alias-label-tertiary);font-size:11px;flex:none}",
      "._kb_treeicon{width:17px;text-align:center;flex:none}",
      "._kb_treetext{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}",
      "._kb_treechildren{margin-left:17px}",
      "._kb_editorbar{height:58px;box-sizing:border-box;display:flex;align-items:center;gap:10px;padding:0 18px;border-bottom:1px solid var(--dsw-alias-border-l2);flex:none}",
      "._kb_fileicon{color:#7c65d7;font-size:16px}",
      "._kb_filename{font-size:14px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}",
      "._kb_titlebutton{border:0;background:transparent;color:inherit;padding:0;text-align:left;cursor:text;font:inherit}",
      "._kb_titlebutton:hover{text-decoration:underline;text-decoration-color:color-mix(in srgb,#7c65d7 60%,transparent);text-underline-offset:3px}",
      "._kb_titleinput{box-sizing:border-box;min-width:0;flex:1;height:32px;border:0;border-bottom:1px solid #7c65d7;border-radius:0;background:transparent;color:var(--dsw-alias-label-primary);outline:0;padding:0;font:600 14px var(--ds-font-family,Inter,system-ui,sans-serif)}",
      "._kb_dirty{color:#c48a25;font-size:11px;white-space:nowrap}",
      "._kb_editor{min-width:0;min-height:0;flex:1;overflow:auto;overscroll-behavior:contain}",
      "._kb_cm{box-sizing:border-box;min-height:100%;max-width:1000px;margin:0 auto;padding:34px 48px 70px;font-size:15px;line-height:1.8;color:var(--dsw-alias-label-primary)}",
      "._kb_cm .cm-editor{min-height:100%;outline:0;background:transparent}",
      "._kb_cm .cm-scroller{overflow:visible;font-family:var(--ds-font-family,Inter,system-ui,sans-serif);line-height:1.8}",
      "._kb_cm .cm-content{min-height:calc(100vh - 150px);padding:0;caret-color:var(--dsw-alias-label-primary)}",
      "._kb_cm .cm-line{padding:0;margin:0 0 14px;white-space:pre-wrap;word-break:break-word}",
      "._kb_cm .cm-line._kb_cm_h1{font-size:28px;font-weight:700;line-height:1.3;margin-bottom:18px}",
      "._kb_cm .cm-line._kb_cm_h2{font-size:22px;font-weight:700;line-height:1.3;margin-top:28px;margin-bottom:18px}",
      "._kb_cm .cm-line._kb_cm_h3{font-size:18px;font-weight:700;line-height:1.3;margin-top:24px;margin-bottom:18px}",
      "._kb_cm ._kb_cm_bold{font-weight:700}",
      "._kb_cm ._kb_cm_link{color:#7c65d7;background:color-mix(in srgb,#7c65d7 12%,transparent);border-radius:4px;padding:1px 3px}",
      "._kb_cm ._kb_cm_hidden{display:none}",
      "._kb_cm[data-title-mode=true] .cm-line{font-size:28px;font-weight:700;line-height:1.3}",
      "._kb_cm[data-title-mode=true] .cm-line:empty::before{content:'输入主题…';color:var(--dsw-alias-label-tertiary)}",
      "._kb_image{max-width:calc(100% - 48px);max-height:70vh;object-fit:contain;margin:34px auto;display:block;border-radius:10px}",
      "._kb_empty{height:100%;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary);font-size:13px;text-align:center;padding:30px;box-sizing:border-box}",
      "._kb_status{height:30px;box-sizing:border-box;padding:0 18px;color:var(--dsw-alias-label-tertiary);font-size:11px;display:flex;align-items:center;justify-content:space-between;border-top:1px solid var(--dsw-alias-border-l1);flex:none}",
      "._kb_chathead{height:58px;box-sizing:border-box;display:flex;align-items:center;gap:9px;padding:0 16px;border-bottom:1px solid var(--dsw-alias-border-l2);flex:none}",
      "._kb_chatdot{width:8px;height:8px;border-radius:50%;background:#7c65d7;box-shadow:0 0 0 4px color-mix(in srgb,#7c65d7 16%,transparent)}",
      "._kb_chatname{font-size:13px;font-weight:600;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      "._kb_chatmenuwrap{position:relative;flex:none}",
      "._kb_chatmenubutton{display:inline-flex;align-items:center;gap:5px;max-width:190px;height:32px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);padding:0 7px;font:11px var(--ds-font-family,Inter,system-ui,sans-serif);cursor:pointer}",
      "._kb_chatmenubutton:hover,._kb_chatmenubutton[data-open=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      "._kb_chatmenubutton span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      "._kb_chatmenu{position:absolute;right:0;top:39px;z-index:2200;width:min(310px,calc(100vw - 28px));max-height:min(520px,calc(100vh - 90px));overflow:auto;box-sizing:border-box;padding:7px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-base);box-shadow:0 14px 34px rgba(36,30,18,.2)}",
      "._kb_chatmenutitle{padding:6px 9px 5px;color:var(--dsw-alias-label-tertiary);font-size:10px}",
      "._kb_chatmenuitem{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);padding:8px 9px;text-align:left;cursor:pointer}",
      "._kb_chatmenuitem:hover,._kb_chatmenuitem[data-current=true]{background:color-mix(in srgb,#7c65d7 12%,var(--dsw-alias-interactive-bg-hover))}",
      "._kb_chatmenuitem strong,._kb_chatmenuitem span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      "._kb_chatmenuitem strong{font-size:12px;font-weight:500;flex:1}",
      "._kb_chatmenuitem span{color:var(--dsw-alias-label-tertiary);font-size:10px}",
      "._kb_chatmenuitem[data-new=true] strong{color:#7c65d7}",
      "._kb_chatmenusep{height:1px;margin:6px 3px;background:var(--dsw-alias-border-l1)}",
      "._kb_controls{min-width:0;flex:1;display:flex;align-items:center;gap:4px}",
      "._kb_control{display:flex;align-items:center;min-width:0;flex:1}",
      "._kb_control:last-child{flex:1.25}",
      "._kb_control label{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}",
      "._kb_select{box-sizing:border-box;min-width:0;width:100%;height:32px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);padding:0 5px;font:12px var(--ds-font-family,Inter,system-ui,sans-serif);outline:0;text-overflow:ellipsis}",
      "._kb_select:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      "._kb_select:focus{background:var(--dsw-alias-interactive-bg-hover);box-shadow:0 0 0 2px color-mix(in srgb,#7c65d7 15%,transparent)}",
      "._kb_select:disabled{opacity:.55}",
      "._kb_controlhint{font-size:10px;color:var(--dsw-alias-label-tertiary);line-height:1.5}",
      "._kb_chatbody{min-width:0;min-height:0;overflow:auto;padding:16px 14px;display:flex;flex-direction:column;gap:12px;flex:1;overscroll-behavior:contain}",
      "._kb_chatnode{min-width:0;display:flex;flex-direction:column;gap:7px}",
      "._kb_msg{max-width:92%;display:flex;flex-direction:column;gap:4px}",
      "._kb_msg[data-role=user]{align-self:flex-end;align-items:flex-end}._kb_msg[data-role=assistant]{align-self:flex-start;align-items:flex-start}",
      "._kb_msglabel{font-size:10px;color:var(--dsw-alias-label-tertiary);padding:0 4px}",
      "._kb_bubble{white-space:pre-wrap;word-break:break-word;border-radius:11px;padding:9px 11px;font-size:12px;line-height:1.65;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      "._kb_msg[data-role=user] ._kb_bubble{background:#7c65d7;color:white;border-bottom-right-radius:4px}",
      "._kb_msg[data-role=assistant] ._kb_bubble{border-bottom-left-radius:4px}",
      "._kb_userbubble{align-self:flex-end;max-width:92%;background:#7c65d7;color:white;border-radius:11px 11px 4px 11px;padding:9px 11px;font-size:12px;line-height:1.65;white-space:pre-wrap;word-break:break-word}",
      "._kb_markdown{align-self:stretch;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.7;word-break:break-word}",
      "._kb_markdown p,._kb_markdown h1,._kb_markdown h2,._kb_markdown h3{margin:0 0 9px}",
      "._kb_markdown h1{font-size:20px;line-height:1.35}._kb_markdown h2{font-size:17px;line-height:1.4}._kb_markdown h3{font-size:15px;line-height:1.45}",
      "._kb_markdown ._kb_mdblank{height:6px}._kb_markdown ._kb_mdlist{margin:0 0 5px;padding-left:16px;white-space:pre-wrap}",
      "._kb_markdown code{border-radius:4px;background:var(--dsw-alias-markdown-code-block);padding:1px 4px;font:12px var(--ds-font-family-code,Consolas,monospace)}",
      "._kb_assistanttext{min-width:0;display:flex;flex-direction:column;gap:3px}",
      "._kb_assistantactions{display:flex;align-items:center;min-height:26px;margin-top:1px}",
      "._kb_copybutton{display:inline-flex;align-items:center;gap:5px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);padding:4px 6px;cursor:pointer;font:11px var(--ds-font-family,Inter,system-ui,sans-serif)}",
      "._kb_copybutton:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}._kb_copybutton:focus-visible{outline:2px solid color-mix(in srgb,#7c65d7 48%,transparent);outline-offset:1px}",
      "._kb_copyicon{width:16px;height:16px;display:block;flex:none}",
      "._kb_contextrow,._kb_thinkrow,._kb_toolrow{min-width:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.6}",
      "._kb_contexttoggle,._kb_thinktoggle,._kb_tooltoggle{width:100%;display:flex;align-items:center;gap:7px;min-width:0;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);padding:2px 0;text-align:left;cursor:pointer;font:inherit}",
      "._kb_contexttoggle:hover,._kb_thinktoggle:hover,._kb_tooltoggle:hover{color:var(--dsw-alias-label-primary)}",
      "._kb_disclosurechevron{width:14px;flex:none;color:var(--dsw-alias-label-secondary);font-size:12px;text-align:center}",
      "._kb_disclosuretitle{flex:none;color:var(--dsw-alias-label-secondary)}",
      "._kb_disclosuresep{width:2px;height:2px;border-radius:50%;background:var(--dsw-alias-label-caption);flex:none}",
      "._kb_disclosuresummary{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}",
      "._kb_contextbody{box-sizing:border-box;width:calc(100% - 21px);max-height:150px;overflow:auto;margin:3px 0 3px 21px;padding:9px 11px;border-radius:8px;background:var(--dsw-alias-markdown-code-block);font:11px/1.55 var(--ds-font-family-code,Consolas,monospace);white-space:pre-wrap;word-break:break-word}",
      "._kb_thinkbody{width:calc(100% - 21px);max-height:220px;overflow:auto;margin:3px 0 3px 21px;padding:3px 0;color:var(--dsw-alias-label-tertiary);white-space:pre-wrap;word-break:break-word}",
      "._kb_toolbody{width:calc(100% - 21px);max-height:180px;overflow:auto;margin:3px 0 3px 21px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-markdown-code-block);white-space:pre-wrap;word-break:break-word}",
      "._kb_thinkrow[data-running=true] ._kb_disclosuresummary{background:linear-gradient(90deg,#7c65d7,#b6a1f3,#7c65d7);background-size:220% 100%;color:transparent;background-clip:text;animation:_kb_think-sweep 1.8s linear infinite}@keyframes _kb_think-sweep{to{background-position:-220% 0}}",
      "._kb_contextrow + ._kb_userbubble{margin-top:1px}",
      "._kb_chatcomposer{padding:10px 12px 12px;border-top:1px solid var(--dsw-alias-border-l2);flex:none}",
      "._kb_compbox{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:16px;background:var(--dsw-alias-bg-base);box-shadow:0 2px 9px rgba(36,30,18,.08);padding:11px 10px 7px;transition:border-color .15s ease,box-shadow .15s ease}",
      "._kb_compbox:focus-within{border-color:color-mix(in srgb,#7c65d7 48%,var(--dsw-alias-border-l2));box-shadow:0 0 0 2px color-mix(in srgb,#7c65d7 11%,transparent),0 2px 9px rgba(36,30,18,.08)}",
      "._kb_attachments{display:flex;flex-wrap:wrap;gap:6px;margin:-2px 0 9px}",
      "._kb_attachment{min-width:0;max-width:100%;display:flex;align-items:center;gap:7px;padding:5px 7px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}",
      "._kb_attachmenticon{width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;border-radius:4px;background:color-mix(in srgb,#7c65d7 14%,transparent);color:#7c65d7;font-size:11px;flex:none}",
      "._kb_attachmentbody{min-width:0;display:flex;flex-direction:column;gap:1px}",
      "._kb_attachmentname{max-width:210px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:11px}",
      "._kb_attachmentmeta{max-width:210px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:9px}",
      "._kb_attachmentremove{width:20px;height:20px;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:14px;line-height:1;flex:none}",
      "._kb_attachmentremove:hover{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}",
      "._kb_chatinput{display:block;box-sizing:border-box;width:100%;min-height:54px;max-height:140px;resize:vertical;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);outline:0;padding:0 1px;font:13px/1.55 var(--ds-font-family,Inter,system-ui,sans-serif)}",
      "._kb_chatinput::placeholder{color:var(--dsw-alias-label-tertiary);opacity:.9}",
      "._kb_compbar{display:flex;align-items:center;gap:6px;min-width:0;margin-top:8px;min-height:34px}",
      "._kb_compadd{box-sizing:border-box;width:32px;height:32px;border:0;border-radius:50%;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-size:23px;font-weight:300;line-height:1;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;flex:none}",
      "._kb_compadd:hover{background:var(--dsw-alias-interactive-bg-hover-accent)}",
      "._kb_chatfoot{display:flex;justify-content:space-between;align-items:center;gap:8px;margin:8px 4px 0;color:var(--dsw-alias-label-tertiary);font-size:10px}",
      "._kb_send{box-sizing:border-box;width:40px;height:40px;border:0;border-radius:50%;background:#cfc19b;color:white;padding:0;font-size:24px;line-height:1;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;flex:none}",
      "._kb_send:hover{background:#c3b487}",
      "._kb_send:disabled{opacity:.48;cursor:default}",
      "._kb_error{margin:18px;padding:12px;border-radius:9px;background:color-mix(in srgb,#c84b4b 10%,transparent);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:1.6}",
      "._kb_hint{padding:16px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.7}",
      "._kb_switch{display:flex;gap:4px;margin:0 4px 8px;padding:3px;border-radius:9px;background:var(--dsw-alias-interactive-bg-hover)}",
      "._kb_switchbtn{flex:1;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font:12px var(--ds-font-family,Inter,system-ui,sans-serif);padding:5px 0;cursor:pointer}",
      "._kb_switchbtn[data-active=true]{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary)}",
      "._kb_kbrow{width:100%;box-sizing:border-box;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);padding:8px;text-align:left;cursor:pointer;display:block}",
      "._kb_kbrow:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      "._kb_kbrowtitle{display:block;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      "._kb_kbrowmeta{display:block;margin-top:3px;font-size:10px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      "._kb_kbsnippet{display:block;margin-top:4px;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);opacity:.85}",
      "._kb_badge{display:inline-block;margin-left:5px;padding:0 5px;border-radius:5px;font-size:9px;line-height:15px;background:color-mix(in srgb,#7c65d7 16%,transparent);color:#7c65d7}",
      "._kb_badge[data-origin=web]{background:color-mix(in srgb,#c8844b 18%,transparent);color:#b06f34}",
      "._kb_badge[data-origin=inferred]{background:color-mix(in srgb,#8a8a8a 18%,transparent);color:var(--dsw-alias-label-secondary)}",
      "._kb_kbhead{display:flex;align-items:center;gap:6px;padding:2px 6px 6px;color:var(--dsw-alias-label-tertiary);font-size:11px}",
      "._kb_kbhead button{margin-left:auto;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:11px}",
      "._kb_kbcheck{display:flex;align-items:center;gap:5px;margin:0 6px 6px;color:var(--dsw-alias-label-tertiary);font-size:11px}",
      // P2 待审区（Inbox）
      "._kb_inbox{margin:0 4px 10px;padding:6px 4px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:color-mix(in srgb,#c8844b 6%,transparent)}",
      "._kb_inboxitem{padding:0 0 6px}",
      "._kb_inboxactions{display:flex;gap:4px;padding:0 6px;margin-top:2px}",
      "._kb_inboxactions button{flex:1;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;padding:3px 0;cursor:pointer}",
      "._kb_inboxactions button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      "._kb_inboxactions button:disabled{opacity:.45;cursor:default}",
      "._kb_inboxactions button[data-danger=true]:hover:not(:disabled){color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,#c84b4b 40%,transparent)}",
      // P4 洞察
      "._kb_insightbox{margin:0 4px 10px;padding:6px 6px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px}",
      "._kb_tags{display:flex;flex-wrap:wrap;gap:4px;padding:2px 2px 0}",
      "._kb_typefilter{margin:2px 6px 6px;padding:0}",
      "._kb_tag{border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px;padding:0 8px;cursor:pointer}",
      "._kb_tag:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      "._kb_tag[data-active=true]{background:color-mix(in srgb,#7c65d7 16%,transparent);color:#7c65d7;border-color:color-mix(in srgb,#7c65d7 35%,transparent)}",
      "._kb_wikiform{display:flex;flex-direction:column;gap:4px;padding:2px 6px 0}",
      "._kb_wikiinput{box-sizing:border-box;width:100%;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);font:11px var(--ds-font-family,Inter,system-ui,sans-serif);padding:4px 7px}",
      "._kb_wikiinput::placeholder{color:var(--dsw-alias-label-tertiary)}",
      "._kb_wikibody{max-height:220px;overflow:auto;margin:2px 6px 0;padding:8px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent);color:var(--dsw-alias-label-secondary);font:11px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word}",
      // P5 图谱 / 缺口
      "._kb_graph{display:block;width:100%;height:auto;margin-top:2px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 3%,transparent);cursor:grab}",
      "._kb_graphedge{stroke:var(--dsw-alias-border-l2);stroke-width:1}",
      "._kb_graphnode{cursor:pointer}",
      "._kb_graphnode circle{fill:color-mix(in srgb,#7c65d7 55%,transparent);stroke:var(--dsw-alias-bg-module-platform);stroke-width:1}",
      "._kb_graphnode:hover circle{fill:#7c65d7}",
      "._kb_graphlabel{font-size:9px;fill:var(--dsw-alias-label-tertiary);pointer-events:none}",
      "._kb_gapitem{display:flex;gap:6px;align-items:flex-start;padding:4px 6px 6px}",
      "._kb_gapitem span{flex:1;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary);word-break:break-word}",
      "._kb_gapitem button{flex:none;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:10px;padding:2px 6px;cursor:pointer}",
      "._kb_gapitem button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      "._kb_gapdone{opacity:.55}",
      "@media(max-width:960px){._kb_overlay{grid-template-columns:220px 1px minmax(280px,1fr)}._kb_resize[data-side=right],._kb_right{display:none}._kb_cm{padding-left:24px;padding-right:24px}}",
      "@media(prefers-reduced-motion:reduce){._kb_button{transition:none;transform:none!important}}"
    ].join("");
    const styleId = "dsh-kb/style";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(styleId) + "]") === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-kb";
      tag.dataset.pluginCss = styleId;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    async function requestJson(url, options) {
      const response = await fetch(url, options);
      let payload = null;
      try { payload = await response.json(); } catch {}
      if (!response.ok) throw new Error(payload?.error || `请求失败（${response.status}）`);
      return payload;
    }

    function contentText(content) {
      if (typeof content === "string") return content;
      if (!Array.isArray(content)) return "";
      return content.map((block) => {
        if (block?.type === "text" || block?.kind === "text" || block?.kind === "reasoning") return block.text || "";
        return "";
      }).join("");
    }

    const OBSIDIAN_CONTEXT_START = "<!-- DSH_OBSIDIAN_CONTEXT_START -->";
    const OBSIDIAN_CONTEXT_END = "<!-- DSH_OBSIDIAN_CONTEXT_END -->";

    function escapePromptAttribute(value) {
      return String(value || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    function unescapePromptAttribute(value) {
      return String(value || "").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    }

    function buildObsidianPrompt(entries, question) {
      const validEntries = entries.filter((entry) => entry?.path && typeof entry.content === "string");
      if (validEntries.length === 0) return question;
      const files = validEntries.map((entry) => `<dsh-obsidian-file path="${escapePromptAttribute(entry.path)}" name="${escapePromptAttribute(entry.name || entry.path)}">\n${entry.content}\n</dsh-obsidian-file>`).join("\n\n");
      return `${OBSIDIAN_CONTEXT_START}\n<dsh-obsidian-context>\n${files}\n</dsh-obsidian-context>\n${OBSIDIAN_CONTEXT_END}\n\n${question}`;
    }

    function parseObsidianPrompt(content) {
      const text = contentText(content);
      const start = text.indexOf(OBSIDIAN_CONTEXT_START);
      const end = start === -1 ? -1 : text.indexOf(OBSIDIAN_CONTEXT_END, start + OBSIDIAN_CONTEXT_START.length);
      if (start === -1 || end === -1) return { question: text.trim(), contexts: [] };
      const body = text.slice(start + OBSIDIAN_CONTEXT_START.length, end);
      const contexts = [];
      const filePattern = /<dsh-obsidian-file\s+path="([^"]*)"\s+name="([^"]*)">\n?([\s\S]*?)\n?<\/dsh-obsidian-file>/g;
      let match;
      while ((match = filePattern.exec(body))) {
        contexts.push({
          path: unescapePromptAttribute(match[1]),
          name: unescapePromptAttribute(match[2]),
          content: match[3]
        });
      }
      return { question: text.slice(end + OBSIDIAN_CONTEXT_END.length).trim(), contexts };
    }

    function useCurrentSession(sessions) {
      const [listSnapshot, setListSnapshot] = useState(() => sessions?.list?.getSnapshot?.() || null);
      useEffect(() => {
        const store = sessions?.list;
        if (!store?.subscribe) {
          setListSnapshot(null);
          return undefined;
        }
        const update = () => setListSnapshot(store.getSnapshot());
        update();
        return store.subscribe(update);
      }, [sessions]);
      const currentId = listSnapshot?.current;
      const session = currentId === undefined ? undefined : sessions.binding(currentId)?.session;
      const [snapshot, setSnapshot] = useState(() => session?.getSnapshot?.() || null);
      useEffect(() => {
        if (!session?.subscribe) {
          setSnapshot(null);
          return undefined;
        }
        const update = () => setSnapshot(session.getSnapshot());
        update();
        return session.subscribe(update);
      }, [session]);
      return { currentId, session, snapshot, listSnapshot };
    }

    function useWorkspaceList(workspaces) {
      const [snapshot, setSnapshot] = useState(() => workspaces?.list?.getSnapshot?.() || null);
      useEffect(() => {
        const store = workspaces?.list;
        if (!store?.subscribe) {
          setSnapshot(null);
          return undefined;
        }
        const update = () => setSnapshot(store.getSnapshot());
        update();
        return store.subscribe(update);
      }, [workspaces]);
      return snapshot;
    }

    function sessionRows(listSnapshot) {
      if (Array.isArray(listSnapshot?.items)) return listSnapshot.items;
      const ids = Array.isArray(listSnapshot?.ids) ? listSnapshot.ids : Object.keys(listSnapshot?.byId || {});
      return ids.map((id) => listSnapshot?.byId?.[id]).filter(Boolean);
    }

    function sessionTitle(item) {
      return item?.displayTitle || item?.title || item?.name || item?.id || item?.sessionId || "未命名对话";
    }

    function workspaceForSession(workspaceSnapshot, sessionId) {
      return (workspaceSnapshot?.items || []).find((workspace) => (workspace.sessionIds || []).includes(sessionId));
    }

    function SessionPicker({ sessions, workspaces, currentId, listSnapshot, onError }) {
      const [open, setOpen] = useState(false);
      const workspaceSnapshot = useWorkspaceList(workspaces);
      const menuRef = useRef(null);
      const currentItem = sessionRows(listSnapshot).find((item) => (item?.sessionId || item?.id) === currentId);
      const currentTitle = currentItem ? sessionTitle(currentItem) : "选择 DSH 会话";

      useEffect(() => {
        if (!open) return undefined;
        const close = (event) => {
          if (!menuRef.current?.contains(event.target)) setOpen(false);
        };
        document.addEventListener("pointerdown", close);
        return () => document.removeEventListener("pointerdown", close);
      }, [open]);

      const openSession = (id) => {
        try {
          sessions?.open?.(id);
          setOpen(false);
        } catch (error) {
          onError?.(error);
        }
      };

      const startSession = (workspaceId) => {
        setOpen(false);
        try {
          if (workspaces?.startSession) {
            workspaces.startSession(workspaceId);
            return;
          }
          const created = sessions?.create?.(workspaceId ? { workspaceId } : undefined);
          Promise.resolve(created).then((id) => id && sessions?.open?.(id)).catch((error) => onError?.(error));
        } catch (error) {
          onError?.(error);
        }
      };

      const rows = sessionRows(listSnapshot).filter((item) => !(item?.blank && !item?.title && !item?.displayTitle));
      const workspacesList = workspaceSnapshot?.items || [];
      return React.createElement("div", { className: "_kb_chatmenuwrap", ref: menuRef },
        React.createElement("button", {
          className: "_kb_chatmenubutton",
          type: "button",
          "data-open": open,
          title: "选择 DSH 工作区或对话",
          onClick: () => setOpen((value) => !value)
        },
          React.createElement("span", null, currentTitle),
          React.createElement("span", { "aria-hidden": true }, "⌄")),
        open && React.createElement("div", { className: "_kb_chatmenu" },
          React.createElement("button", { className: "_kb_chatmenuitem", "data-new": true, type: "button", onClick: () => startSession() },
            React.createElement("strong", null, "＋ 新建对话"),
            React.createElement("span", null, "当前工作区")),
          workspacesList.length > 0 && React.createElement("div", { className: "_kb_chatmenusep" }),
          workspacesList.length > 0 && React.createElement("div", { className: "_kb_chatmenutitle" }, "工作区"),
          workspacesList.map((workspace) => React.createElement("button", { className: "_kb_chatmenuitem", type: "button", key: workspace.workspaceId, onClick: () => startSession(workspace.workspaceId) },
            React.createElement("strong", null, `＋ ${workspace.title || workspace.path}`),
            React.createElement("span", null, `${(workspace.sessionIds || []).length} 个对话`))),
          rows.length > 0 && React.createElement("div", { className: "_kb_chatmenusep" }),
          rows.length > 0 && React.createElement("div", { className: "_kb_chatmenutitle" }, "最近对话"),
          rows.map((item) => {
            const id = item?.sessionId || item?.id;
            const workspace = workspaceForSession(workspaceSnapshot, id);
            return React.createElement("button", { className: "_kb_chatmenuitem", "data-current": id === currentId, type: "button", key: id, onClick: () => openSession(id) },
              React.createElement("strong", null, sessionTitle(item)),
              React.createElement("span", null, workspace?.title || item?.cwd || ""));
          })));
    }

    function chatItems(snapshot) {
      const order = snapshot?.chat?.order || [];
      const nodes = snapshot?.chat?.nodes;
      return order.map((key) => {
        const node = typeof nodes?.get === "function" ? nodes.get(key) : nodes?.[key];
        return node ? { ...node, key } : null;
      }).filter(Boolean).slice(-40);
    }

    class HiddenMarkdownToken extends WidgetType {
      toDOM() {
        const node = document.createElement("span");
        node.className = "_kb_cm_hidden";
        return node;
      }
      ignoreEvent() { return true; }
    }

    const hiddenMarkdownToken = Decoration.replace({ widget: new HiddenMarkdownToken() });
    const headingLineDecorations = [null, "_kb_cm_h1", "_kb_cm_h2", "_kb_cm_h3", "_kb_cm_h3", "_kb_cm_h3", "_kb_cm_h3"];

    function livePreviewDecorations(view) {
      const activeLines = new Set();
      for (const range of view.state.selection.ranges) {
        const start = view.state.doc.lineAt(range.from).number;
        const end = view.state.doc.lineAt(range.to).number;
        for (let line = start; line <= end; line += 1) activeLines.add(line);
      }

      const ranges = [];
      const add = (from, to, decoration, priority = 0) => {
        if (to >= from) ranges.push({ from, to, decoration, priority });
      };

      for (let number = 1; number <= view.state.doc.lines; number += 1) {
        const line = view.state.doc.line(number);
        const text = line.text;
        const active = activeLines.has(number);
        const heading = text.match(/^(#{1,6})(\s+)(.*)$/);
        if (heading) {
          const level = Math.min(Number(heading[1].length), 3);
          add(line.from, line.from, Decoration.line({ attributes: { class: headingLineDecorations[level] } }), -10);
          if (!active) add(line.from, line.from + heading[1].length + heading[2].length, hiddenMarkdownToken, 0);
        }

        const boldPattern = /##([^#\n]+)##/g;
        let boldMatch;
        while ((boldMatch = boldPattern.exec(text))) {
          const start = line.from + boldMatch.index;
          const contentStart = start + 2;
          const contentEnd = contentStart + boldMatch[1].length;
          if (!active) add(start, contentStart, hiddenMarkdownToken, 1);
          add(contentStart, contentEnd, Decoration.mark({ class: "_kb_cm_bold" }), 2);
          if (!active) add(contentEnd, contentEnd + 2, hiddenMarkdownToken, 3);
        }

        const linkPattern = /\[\[[^\]]+\]\]/g;
        let linkMatch;
        while ((linkMatch = linkPattern.exec(text))) {
          add(line.from + linkMatch.index, line.from + linkMatch.index + linkMatch[0].length, Decoration.mark({ class: "_kb_cm_link" }), 4);
        }
      }

      ranges.sort((a, b) => a.from - b.from || a.priority - b.priority || a.to - b.to);
      const builder = new RangeSetBuilder();
      for (const item of ranges) builder.add(item.from, item.to, item.decoration);
      return builder.finish();
    }

    const livePreviewPlugin = ViewPlugin.fromClass(class {
      constructor(view) { this.decorations = livePreviewDecorations(view); }
      update(update) {
        if (update.docChanged || update.selectionSet || update.viewportChanged) this.decorations = livePreviewDecorations(update.view);
      }
    }, { decorations: (value) => value.decorations });

    function LiveMarkdownEditor({ markdown: source, onChange }) {
      const hostRef = useRef(null);
      const viewRef = useRef(null);
      const onChangeRef = useRef(onChange);
      const titleModeRef = useRef(!String(source || "").trim());
      const [titleMode, setTitleMode] = useState(titleModeRef.current);

      useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

      useEffect(() => {
        if (!hostRef.current) return undefined;
        const initial = String(source || "");
        const ensureTitleLine = (view) => {
          if (!titleModeRef.current || view.state.doc.length > 0) return;
          view.dispatch({ changes: { from: 0, insert: "# " }, selection: { anchor: 2 } });
        };
        const updateListener = EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          const value = update.state.doc.toString();
          const placeholder = titleModeRef.current && (value === "" || value === "# ");
          setTitleMode(placeholder);
          if (placeholder) return;
          titleModeRef.current = false;
          onChangeRef.current(value);
        });
        const view = new EditorView({
          state: EditorState.create({
            doc: initial,
            extensions: [
              markdown(),
              syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
              history(),
              keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
              EditorView.lineWrapping,
              livePreviewPlugin,
              updateListener,
              EditorView.domEventHandlers({ focus: ensureTitleLine }),
              EditorView.theme({
                "&.cm-focused": { outline: "none" },
                ".cm-selectionBackground, ::selection": { backgroundColor: "color-mix(in srgb, #7c65d7 18%, transparent)" }
              })
            ]
          }),
          parent: hostRef.current
        });
        viewRef.current = view;
        return () => {
          view.destroy();
          viewRef.current = null;
        };
      }, []);

      useEffect(() => {
        const view = viewRef.current;
        const next = String(source || "");
        if (!view || view.state.doc.toString() === next) return;
        titleModeRef.current = !next.trim();
        setTitleMode(titleModeRef.current);
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } });
      }, [source]);

      return React.createElement("div", { className: "_kb_cm", ref: hostRef, "data-title-mode": titleMode ? "true" : "false" });
    }

    function TreeDirectory({ entry, selected, onOpen, revision, movingEntry, dropTargetPath, onMoveStart, onMoveTarget, onMoveHover, onMoveCancel, onFolderFocus, onContextMenu }) {
      const [open, setOpen] = useState(false);
      const [tree, setTree] = useState(null);
      const [error, setError] = useState("");
      const timer = useRef(null);
      const longPressed = useRef(false);
      const dragged = useRef(false);
      const load = useCallback(() => requestJson(`${API}/tree?path=${encodeURIComponent(entry.path)}`).then((payload) => {
        setTree(payload);
        setError("");
      }).catch((e) => setError(e.message)), [entry.path]);
      useEffect(() => {
        if (open) load();
      }, [open, load, revision]);
      const clearPress = () => {
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = null;
      };
      const startPress = (event) => {
        if (event.button !== 0 || movingEntry) return;
        longPressed.current = false;
        clearPress();
        timer.current = window.setTimeout(() => {
          longPressed.current = true;
          onMoveStart(entry);
        }, 600);
      };
      const wasLongPress = () => {
        if (!longPressed.current) return false;
        longPressed.current = false;
        return true;
      };
      const toggle = async () => {
        if (movingEntry) {
          onMoveTarget(entry);
          return;
        }
        onFolderFocus(entry.path);
        const next = !open;
        setOpen(next);
      };
      const startDrag = (event) => {
        dragged.current = true;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", entry.path);
        onMoveStart(entry);
      };
      return React.createElement(React.Fragment, null,
        React.createElement("button", {
          className: "_kb_treeentry",
          type: "button",
          draggable: true,
          "data-moving": movingEntry?.path === entry.path,
          "data-drop-target": Boolean(dropTargetPath === entry.path && movingEntry?.path !== entry.path),
          onPointerDown: startPress,
          onPointerUp: clearPress,
          onPointerLeave: clearPress,
          onPointerCancel: clearPress,
          onDragStart: startDrag,
          onDragEnd: () => { window.setTimeout(() => { dragged.current = false; onMoveCancel(); }, 0); },
          onDragEnter: (event) => { if (event.dataTransfer.types.includes("text/plain")) { event.preventDefault(); onMoveHover(entry); } },
          onDragOver: (event) => { if (event.dataTransfer.types.includes("text/plain")) { event.preventDefault(); onMoveHover(entry); } },
          onDrop: (event) => { event.preventDefault(); onMoveTarget(entry); },
          onContextMenu: (event) => onContextMenu(event, entry),
          onClick: () => { if (!wasLongPress() && !dragged.current) toggle(); }
        },
          React.createElement("span", { className: "_kb_treeicon" }, open ? "▾" : "▸"),
          React.createElement("span", { className: "_kb_treetext" }, entry.name)),
        open && React.createElement("div", { className: "_kb_treechildren" },
          error ? React.createElement("div", { className: "_kb_hint" }, error) : tree && React.createElement(TreeContents, { tree, selected, onOpen, revision, movingEntry, dropTargetPath, onMoveStart, onMoveTarget, onMoveHover, onMoveCancel, onFolderFocus, onContextMenu }))
      );
    }

    function TreeFile({ entry, selected, onOpen, movingEntry, onMoveStart, onMoveCancel, onContextMenu }) {
      const timer = useRef(null);
      const longPressed = useRef(false);
      const dragged = useRef(false);
      const clearPress = () => {
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = null;
      };
      const startPress = (event) => {
        if (event.button !== 0 || movingEntry) return;
        longPressed.current = false;
        clearPress();
        timer.current = window.setTimeout(() => {
          longPressed.current = true;
          onMoveStart(entry);
        }, 600);
      };
      const handleClick = () => {
        if (longPressed.current || dragged.current) {
          longPressed.current = false;
          dragged.current = false;
          return;
        }
        if (!movingEntry) onOpen(entry);
      };
      const startDrag = (event) => {
        dragged.current = true;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", entry.path);
        onMoveStart(entry);
      };
      return React.createElement("button", {
        className: "_kb_treeentry",
        type: "button",
        draggable: true,
        "data-selected": selected === entry.path,
        "data-moving": movingEntry?.path === entry.path,
        onPointerDown: startPress,
        onPointerUp: clearPress,
        onPointerLeave: clearPress,
        onPointerCancel: clearPress,
        onDragStart: startDrag,
        onDragEnd: () => { window.setTimeout(() => { dragged.current = false; onMoveCancel(); }, 0); },
        onContextMenu: (event) => onContextMenu(event, entry),
        onClick: handleClick
      },
        React.createElement("span", { className: "_kb_treeicon" }, entry.kind === "image" ? "▧" : "·"),
        React.createElement("span", { className: "_kb_treetext" }, entry.name));
    }

    function TreeContents({ tree, selected, onOpen, revision, movingEntry, dropTargetPath, onMoveStart, onMoveTarget, onMoveHover, onMoveCancel, onFolderFocus, onContextMenu }) {
      return React.createElement(React.Fragment, null,
        tree.dirs.map((entry) => React.createElement(TreeDirectory, { key: entry.path, entry, selected, onOpen, revision, movingEntry, dropTargetPath, onMoveStart, onMoveTarget, onMoveHover, onMoveCancel, onFolderFocus, onContextMenu })),
        tree.files.map((entry) => React.createElement(TreeFile, { key: entry.path, entry, selected, onOpen, movingEntry, onMoveStart, onMoveCancel, onContextMenu }))
      );
    }

    function VaultTree({ selected, onOpen, revision, movingEntry, dropTargetPath, onMoveStart, onMoveTarget, onMoveHover, onMoveCancel, onFolderFocus, onContextMenu }) {
      const [tree, setTree] = useState(null);
      const [error, setError] = useState("");
      const load = useCallback(() => requestJson(`${API}/tree`).then((payload) => {
        setTree(payload);
        setError("");
      }).catch((e) => setError(e.message)), []);
      useEffect(() => { load(); }, [load, revision]);
      if (error) return React.createElement("div", { className: "_kb_error" }, error);
      if (!tree) return React.createElement("div", { className: "_kb_hint" }, "正在读取仓库…");
      return React.createElement(TreeContents, { tree, selected, onOpen, revision, movingEntry, dropTargetPath, onMoveStart, onMoveTarget, onMoveHover, onMoveCancel, onFolderFocus, onContextMenu });
    }

    function SearchResults({ payload, loading, onOpen }) {
      if (loading) return React.createElement("div", { className: "_kb_hint" }, "正在搜索…");
      if (payload?.error) return React.createElement("div", { className: "_kb_error" }, payload.error);
      if (!payload?.results?.length) return React.createElement("div", { className: "_kb_hint" }, "没有找到匹配的笔记");
      return React.createElement("div", null,
        payload.results.map((entry) => React.createElement("button", { key: entry.path, className: "_kb_searchresult", type: "button", onClick: () => onOpen(entry) },
          React.createElement("span", { className: "_kb_searchname" }, entry.name),
          React.createElement("span", { className: "_kb_searchpath" }, entry.path),
          entry.excerpt && React.createElement("span", { className: "_kb_searchexcerpt" }, `${entry.lineNumber ? `第 ${entry.lineNumber} 行：` : "文件名匹配："}${entry.excerpt}`))),
        payload.truncated && React.createElement("div", { className: "_kb_hint" }, "结果较多，已显示前 100 条"));
    }

    function displayPermissionName(option) {
      const value = option?.name || option?.value || "";
      if (value === "danger-full-access") return "Full access";
      return value.split("-").map((part) => part ? part.charAt(0).toUpperCase() + part.slice(1) : part).join(" ");
    }

    function SessionControls({ session, currentId, listSnapshot, modelDirectories }) {
      const [directory, setDirectory] = useState(null);
      const [modelState, setModelState] = useState(null);
      const [projectionValues, setProjectionValues] = useState(() => session?.projections?.values?.() || null);
      const [modelError, setModelError] = useState("");
      const [permissionError, setPermissionError] = useState("");
      const [permissionBusy, setPermissionBusy] = useState(false);

      useEffect(() => {
        if (!session?.projections?.subscribeAny) {
          setProjectionValues(null);
          return undefined;
        }
        const update = () => setProjectionValues(session.projections.values());
        update();
        return session.projections.subscribeAny(update);
      }, [session]);

      useEffect(() => {
        if (!currentId || !modelDirectories?.directoryFor) {
          setDirectory(null);
          setModelState(null);
          return undefined;
        }
        let nextDirectory;
        try {
          nextDirectory = modelDirectories.directoryFor(currentId);
        } catch (error) {
          setDirectory(null);
          setModelState(null);
          setModelError(error.message);
          return undefined;
        }
        setDirectory(nextDirectory);
        setModelState(nextDirectory.store.getSnapshot());
        setModelError("");
        const stop = nextDirectory.store.subscribe(() => setModelState(nextDirectory.store.getSnapshot()));
        nextDirectory.load().catch((error) => setModelError(error.message));
        return stop;
      }, [currentId, modelDirectories]);

      const modelOptions = useMemo(() => (modelState?.groups || []).flatMap((group) => (group.models || []).map((model) => ({
        value: `${group.id}::${model.id}`,
        provider: group.id,
        model: model.id,
        label: model.name || model.id,
        detail: group.name || group.id,
        reasoningEffort: model.reasoning?.defaultEffort
      }))), [modelState]);
      const currentModel = modelState?.current;
      const currentModelValue = currentModel ? `${currentModel.provider}::${currentModel.model}` : "";
      const currentItem = sessionRows(listSnapshot).find((item) => (item.sessionId || item.id) === currentId);
      const permissions = projectionValues?.permissions || currentItem?.projectionValues?.permissions;
      const permissionOptions = (permissions?.options || []).filter((option) => option.value !== "custom");

      const selectModel = async (event) => {
        const choice = modelOptions.find((option) => option.value === event.target.value);
        if (!choice || !directory) return;
        setModelError("");
        try {
          await directory.select({
            provider: choice.provider,
            model: choice.model,
            ...choice.reasoningEffort === undefined ? {} : { reasoningEffort: choice.reasoningEffort }
          });
        } catch (error) {
          setModelError(error.message);
        }
      };

      const selectPermission = async (event) => {
        const value = event.target.value;
        if (!value || !session || permissionBusy) return;
        if (value === "danger-full-access" && !window.confirm("Full access 会允许当前会话执行更高风险的操作。确定要切换吗？")) {
          event.target.value = permissions?.currentValue || "";
          return;
        }
        setPermissionBusy(true);
        setPermissionError("");
        try {
          const result = await session.command(`/permission ${value}`);
          if (result && result.ok === false) throw new Error(result.error?.message || "权限切换失败");
        } catch (error) {
          setPermissionError(error.message);
        } finally {
          setPermissionBusy(false);
        }
      };

      const controlError = modelError || permissionError;
      return React.createElement("div", { className: "_kb_controls" },
        React.createElement("div", { className: "_kb_control" },
          React.createElement("label", null, "权限"),
          React.createElement("select", {
            className: "_kb_select",
            value: permissions?.currentValue || "",
            disabled: !session || permissionBusy || permissionOptions.length === 0,
            onChange: selectPermission,
            title: permissionError || "切换当前 DSH 会话权限"
          },
            !permissions && React.createElement("option", { value: "" }, session ? "当前会话未提供权限选项" : "请先打开会话"),
            permissionOptions.map((option) => React.createElement("option", { value: option.value, key: option.value }, displayPermissionName(option)))
          )
        ),
        React.createElement("div", { className: "_kb_control" },
          React.createElement("label", null, "模型"),
          React.createElement("select", {
            className: "_kb_select",
            value: currentModelValue,
            disabled: !session || !directory || modelState?.status === "loading" || modelState?.status === "selecting" || modelOptions.length === 0,
            onChange: selectModel,
            title: modelError || "切换当前 DSH 会话模型"
          },
            !currentModelValue && React.createElement("option", { value: "" }, modelState?.status === "loading" ? "正在读取模型…" : "选择模型"),
            modelOptions.map((option) => React.createElement("option", { value: option.value, key: option.value }, `${option.label} · ${option.detail}`))
          )
        ),
        controlError ? React.createElement("div", { className: "_kb_controlhint" }, controlError) : null
      );
    }

    function renderInlineMarkdown(text, keyPrefix) {
      return String(text || "").split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, index) => {
        if (part.startsWith("**") && part.endsWith("**")) return React.createElement("strong", { key: `${keyPrefix}-strong-${index}` }, part.slice(2, -2));
        if (part.startsWith("`") && part.endsWith("`")) return React.createElement("code", { key: `${keyPrefix}-code-${index}` }, part.slice(1, -1));
        return React.createElement(React.Fragment, { key: `${keyPrefix}-text-${index}` }, part);
      });
    }

    function ChatMarkdown({ text }) {
      const lines = String(text || "").replace(/\r/g, "").split("\n");
      return React.createElement("div", { className: "_kb_markdown" }, lines.map((line, index) => {
        const heading = line.match(/^\s*(#{1,3})\s+(.+)$/);
        if (!line.trim()) return React.createElement("div", { className: "_kb_mdblank", key: `blank-${index}` });
        if (heading) {
          const Tag = heading[1].length === 1 ? "h1" : heading[1].length === 2 ? "h2" : "h3";
          return React.createElement(Tag, { key: `heading-${index}` }, renderInlineMarkdown(heading[2], `heading-${index}`));
        }
        const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
        if (unordered) return React.createElement("div", { className: "_kb_mdlist", key: `ul-${index}` }, ["• ", ...renderInlineMarkdown(unordered[1], `ul-${index}`)]);
        const ordered = line.match(/^\s*(\d+)[.)]\s+(.+)$/);
        if (ordered) return React.createElement("div", { className: "_kb_mdlist", key: `ol-${index}` }, [`${ordered[1]}. `, ...renderInlineMarkdown(ordered[2], `ol-${index}`)]);
        return React.createElement("p", { key: `paragraph-${index}` }, renderInlineMarkdown(line, `paragraph-${index}`));
      }));
    }

    async function copyToClipboard(text) {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
      }
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      textarea.remove();
      if (!copied) throw new Error("复制失败");
    }

    function CopyButton({ text }) {
      const [copied, setCopied] = useState(false);
      const copy = async () => {
        if (!text) return;
        try {
          await copyToClipboard(text);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1400);
        } catch {}
      };
      return React.createElement("div", { className: "_kb_assistantactions" },
        React.createElement("button", {
          className: "_kb_copybutton",
          type: "button",
          title: copied ? "已复制" : "复制本次回答",
          "aria-label": copied ? "已复制" : "复制本次回答",
          onClick: copy
        },
          React.createElement("svg", { className: "_kb_copyicon", viewBox: "0 0 24 24", fill: "none", "aria-hidden": true },
            React.createElement("rect", { x: "8", y: "8", width: "12", height: "12", rx: "2", stroke: "currentColor", "strokeWidth": "1.8" }),
            React.createElement("path", { d: "M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2", stroke: "currentColor", "strokeWidth": "1.8", "strokeLinecap": "round" })),
          copied ? "已复制" : "复制"));
    }

    function AssistantReply({ text }) {
      return React.createElement("div", { className: "_kb_assistanttext" },
        React.createElement(ChatMarkdown, { text }),
        React.createElement(CopyButton, { text }));
    }

    function ChatDisclosure({ className, title, summary, body, running = false }) {
      const [open, setOpen] = useState(false);
      return React.createElement("div", { className, "data-running": running },
        React.createElement("button", {
          className: className === "_kb_contextrow" ? "_kb_contexttoggle" : className === "_kb_thinkrow" ? "_kb_thinktoggle" : "_kb_tooltoggle",
          type: "button",
          onClick: () => setOpen((value) => !value)
        },
          React.createElement("span", { className: "_kb_disclosurechevron", "aria-hidden": true }, open ? "⌄" : "›"),
          React.createElement("span", { className: "_kb_disclosuretitle" }, title),
          summary && React.createElement("span", { className: "_kb_disclosuresep", "aria-hidden": true }),
          summary && React.createElement("span", { className: "_kb_disclosuresummary", title: summary }, summary)),
        open && body);
    }

    function ObsidianContextRow({ entry, source = "Obsidian 文件" }) {
      return React.createElement(ChatDisclosure, {
        className: "_kb_contextrow",
        title: source,
        summary: entry.name || entry.path,
        body: React.createElement("div", { className: "_kb_contextbody" }, entry.content || "")
      });
    }

    function ThinkRow({ text, running }) {
      const summary = String(text || "").trim().split("\n").filter(Boolean).slice(-1)[0] || (running ? "思考中…" : "思考");
      return React.createElement(ChatDisclosure, {
        className: "_kb_thinkrow",
        title: "Think",
        summary,
        running,
        body: React.createElement("div", { className: "_kb_thinkbody" }, text || "")
      });
    }

    function ToolRow({ title, summary, body, running = false }) {
      return React.createElement(ChatDisclosure, {
        className: "_kb_toolrow",
        title,
        summary,
        running,
        body: body ? React.createElement("div", { className: "_kb_toolbody" }, body) : null
      });
    }

    function ChatNode({ node }) {
      const data = node?.data || {};
      if (node?.kind === "user" || node?.kind === "steering") {
        const parsed = parseObsidianPrompt(data.content);
        return React.createElement("div", { className: "_kb_chatnode" },
          parsed.contexts.map((entry, index) => React.createElement(ObsidianContextRow, { entry, key: `${node.key}-context-${index}` })),
          parsed.question && React.createElement("div", { className: "_kb_userbubble" }, parsed.question));
      }
      if (node?.kind === "context") {
        const source = data.provenance?.label || data.source?.label || data.source || "上下文注入";
        const content = contentText(data.content);
        return React.createElement("div", { className: "_kb_chatnode" }, React.createElement(ObsidianContextRow, {
          entry: { name: source, path: source, content },
          source: data.provenance?.role === "recall" ? "会话回忆" : "上下文注入"
        }));
      }
      if (node?.kind === "assistant-step" || node?.kind === "assistant") {
        const blocks = Array.isArray(data.blocks) ? data.blocks : [];
        const running = data.status === "running";
        const textBlocks = blocks.filter((block) => block?.kind === "text");
        const replyText = textBlocks.map((block) => block.text || "").join("\n\n");
        const lastTextIndex = blocks.reduce((last, block, index) => block?.kind === "text" ? index : last, -1);
        const renderedBlocks = blocks.length === 0 && running ? [React.createElement(ThinkRow, { key: `${node.key}-think-empty`, text: "思考中…", running: true })] : blocks.map((block, index) => {
          if (block?.kind === "reasoning") return React.createElement(ThinkRow, { key: `${node.key}-think-${index}`, text: block.text || "", running });
          if (block?.kind === "text") return index === lastTextIndex ? React.createElement(AssistantReply, { key: `${node.key}-text-${index}`, text: replyText }) : React.createElement(ChatMarkdown, { key: `${node.key}-text-${index}`, text: block.text || "" });
          if (!block) return null;
          return React.createElement(ToolRow, {
            key: `${node.key}-block-${index}`,
            title: block.kind || "附加内容",
            summary: block.name || block.type || "",
            body: block.text || JSON.stringify(block, null, 2)
          });
        });
        return React.createElement("div", { className: "_kb_chatnode" }, renderedBlocks);
      }
      if (node?.kind === "tool-call") {
        const root = data.root || data;
        return React.createElement("div", { className: "_kb_chatnode" }, React.createElement(ToolRow, {
          title: root.name || root.tool || "工具调用",
          summary: root.status || (root.result ? "已完成" : "执行中…"),
          running: !root.result && !root.error,
          body: root.result || root.error || root.input ? JSON.stringify(root.result || root.error || root.input, null, 2) : ""
        }));
      }
      if (node?.kind === "command") {
        const outcome = data.outcome || {};
        return React.createElement("div", { className: "_kb_chatnode" }, React.createElement(ToolRow, {
          title: data.name || "命令",
          summary: outcome.text || (outcome.kind === "error" ? "执行失败" : outcome.kind ? "已完成" : "执行中…"),
          running: !outcome.kind,
          body: outcome.text || ""
        }));
      }
      if (node?.kind === "model-retry") {
        const retry = data.current || data;
        return React.createElement("div", { className: "_kb_chatnode" }, React.createElement(ToolRow, {
          title: "模型重试",
          summary: retry.message || retry.retryState || "正在重试…",
          running: retry.retryState === "scheduled"
        }));
      }
      if (node?.kind === "turn-error" || node?.kind === "unknown") {
        return React.createElement("div", { className: "_kb_error" }, data.message || data.error?.message || "会话出现错误");
      }
      return null;
    }

    function ChatPanel({ sessions, workspaces, modelDirectories, notePath, noteContent, insertRequest }) {
      const { currentId, session, snapshot, listSnapshot } = useCurrentSession(sessions);
      const [draft, setDraft] = useState("");
      const [attachments, setAttachments] = useState([]);
      const [sending, setSending] = useState(false);
      const [error, setError] = useState("");
      const items = useMemo(() => chatItems(snapshot), [snapshot]);
      const snapshotError = snapshot?.promptError?.error?.message || snapshot?.lastAgentError || "";
      useEffect(() => {
        if (!insertRequest?.id || typeof insertRequest.content !== "string") return;
        setAttachments((value) => value.some((entry) => entry.path === insertRequest.path) ? value : [...value, insertRequest]);
      }, [insertRequest?.id]);
      const send = async () => {
        const question = draft.trim();
        if (!question || !session || sending) return;
        setSending(true);
        setError("");
        const contextEntries = [...attachments];
        if (notePath && noteContent !== null && !contextEntries.some((entry) => entry.path === notePath)) {
          contextEntries.push({ name: notePath.split("/").pop(), path: notePath, content: noteContent.slice(0, 16000), kind: "file" });
        }
        const context = buildObsidianPrompt(contextEntries, question);
        try {
          const result = await session.prompt([{ type: "text", text: context }], "queue");
          if (!result?.ok) throw new Error(result?.error?.message || "消息没有发送成功");
          setDraft("");
          setAttachments([]);
        } catch (e) {
          setError(e.message);
        } finally {
          setSending(false);
        }
      };
      return React.createElement("div", { className: "_kb_right" },
        React.createElement("div", { className: "_kb_chathead" },
          React.createElement("span", { className: "_kb_chatdot" }),
          React.createElement("span", { className: "_kb_chatname" }, session ? "当前 DSH 会话" : "DSH 对话"),
          React.createElement(SessionPicker, { sessions, workspaces, currentId, listSnapshot, onError: (error) => setError(error?.message || String(error)) })),
        React.createElement("div", { className: "_kb_chatbody" },
          !session && React.createElement("div", { className: "_kb_hint" }, "请先在 DSH 中打开一个会话，右侧就能继续使用当前对话。"),
          session && items.length === 0 && React.createElement("div", { className: "_kb_hint" }, "从当前笔记开始提问。发送后，AI 会继续写入当前 DSH 会话。"),
          items.map((item) => React.createElement(ChatNode, { node: item, key: item.key })),
          (error || snapshotError) && React.createElement("div", { className: "_kb_error" }, error || snapshotError)),
        React.createElement("div", { className: "_kb_chatcomposer" },
          React.createElement("div", { className: "_kb_compbox" },
            attachments.length > 0 && React.createElement("div", { className: "_kb_attachments" }, attachments.map((attachment, index) => React.createElement(
              "div",
              { className: "_kb_attachment", key: `${attachment.id}-${index}` },
              React.createElement("span", { className: "_kb_attachmenticon", "aria-hidden": true }, attachment.kind === "directory" ? "□" : "▤"),
              React.createElement("div", { className: "_kb_attachmentbody" },
                React.createElement("span", { className: "_kb_attachmentname", title: attachment.name }, attachment.name),
                React.createElement("span", { className: "_kb_attachmentmeta", title: attachment.path }, attachment.kind === "directory" ? `文件夹 · ${attachment.fileCount || 0} 个文件` : "文件 · 已载入上下文")),
              React.createElement("button", { className: "_kb_attachmentremove", type: "button", title: "移除附件", "aria-label": `移除${attachment.name}`, onClick: () => setAttachments((value) => value.filter((_, itemIndex) => itemIndex !== index)) }, "×")
            ))),
            React.createElement("textarea", {
              className: "_kb_chatinput",
              value: draft,
              disabled: !session || sending,
              placeholder: session ? "围绕当前笔记提问…" : "请先打开一个 DSH 会话",
              onChange: (event) => setDraft(event.target.value),
              onKeyDown: (event) => {
                const composing = event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229;
                if (event.key === "Enter" && !event.shiftKey && !composing) {
                  event.preventDefault();
                  send();
                }
              }
            }),
            React.createElement("div", { className: "_kb_compbar" },
              React.createElement("span", { className: "_kb_compadd", "aria-hidden": true }, "+"),
              React.createElement(SessionControls, { session, currentId, listSnapshot, modelDirectories }),
              React.createElement("button", {
                className: "_kb_send",
                type: "button",
                disabled: !session || !draft.trim() || sending,
                "aria-label": sending ? "发送中" : "发送",
                title: sending ? "发送中" : "发送",
                onClick: send
              }, sending ? "…" : "↑"))
          ),
          React.createElement("div", { className: "_kb_chatfoot" },
            React.createElement("span", null, "Ctrl/Cmd + Enter 发送")))
      );
    }

    function ResizeHandle({ side, dragging, onPointerDown }) {
      return React.createElement("div", {
        className: "_kb_resize",
        "data-side": side,
        "data-dragging": dragging,
        role: "separator",
        "aria-orientation": "vertical",
        "aria-label": side === "left" ? "调整左侧栏宽度" : "调整右侧栏宽度",
        onPointerDown: (event) => onPointerDown(side, event)
      });
    }

    // dsh-kb: 「知识」面板 —— L0 项目索引 + L1 BM25 检索（带 origin 来源标记）。
    // 与左侧文件树并存，由顶部分段开关切换；点结果即在中间编辑器原地打开。
    // 面板级错误边界：某一段渲染抛错时只显示该段的错误，而不是让整个知识中心白屏
    // （没有边界时 React 会卸载整棵树 —— 用户只会看到"点了没反应"）。
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: "" };
      }

      static getDerivedStateFromError(error) {
        return { error: error?.message || String(error) };
      }

      componentDidCatch(error, info) {
        try {
          console.error("[dsh-kb] panel crashed:", this.props.label, error, info);
        } catch {}
      }

      render() {
        if (this.state.error) {
          return React.createElement("div", { className: "_kb_error" },
            `${this.props.label || "面板"}渲染出错：${this.state.error}`,
            React.createElement("div", { className: "_kb_hint" }, "工作台其余部分不受影响。硬刷新（Ctrl+Shift+R）后再试；若仍报错，把这段文字发给我。"));
        }
        return this.props.children;
      }
    }

    function KnowledgePanel({ onOpen, query: queryProp, onQueryChange }) {
      const [data, setData] = useState(null);
      const [project, setProject] = useState(null);
      const [queryState, setQueryState] = useState("");
      // 允许外部驱动检索词（洞察里的标签点击 → 跳到知识页并直接搜）
      const query = queryProp === undefined ? queryState : queryProp;
      const setQuery = (value) => {
        setQueryState(value);
        if (onQueryChange) onQueryChange(value);
      };
      const [results, setResults] = useState(null);
      const [includeWeb, setIncludeWeb] = useState(false);
      const [typeFilter, setTypeFilter] = useState("");
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState("");

      const load = useCallback(async (nextProject) => {
        setBusy(true);
        setError("");
        try {
          const url = `${API}/knowledge/index` + (nextProject ? `?project=${encodeURIComponent(nextProject)}` : "");
          setData(await requestJson(url));
          setProject(nextProject ?? null);
        } catch (e) {
          setError(e.message);
        } finally {
          setBusy(false);
        }
      }, []);

      useEffect(() => {
        if (!data) load(null);
      }, [data, load]);

      // P2 待审区：capture 落进来的东西先在这里排队，人工决定 归库/合并/丢弃。
      const [inbox, setInbox] = useState(null);
      const [inboxBusy, setInboxBusy] = useState(false);

      const loadInbox = useCallback(async () => {
        try {
          setInbox(await requestJson(`${API}/knowledge/inbox`));
        } catch (e) {
          setError(e.message);
        }
      }, []);

      useEffect(() => {
        if (!inbox) loadInbox();
      }, [inbox, loadInbox]);

      // 面板上的点击本身就是人的显式同意，所以这里不走 approval 弹窗（工具调用才走）。
      const inboxAction = useCallback(async (action, item, extra = {}) => {
        setInboxBusy(true);
        setError("");
        try {
          await requestJson(`${API}/knowledge/inbox`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(Object.assign({ action, path: item.path }, extra))
          });
          await loadInbox();
          await load(project);
        } catch (e) {
          setError(e.message);
        } finally {
          setInboxBusy(false);
        }
      }, [project, load, loadInbox]);

      // overrideType：type chip 点击时用它传新值，避免 setState 尚未生效导致用旧过滤重搜。
      const search = useCallback(async (event, overrideType) => {
        if (event) event.preventDefault();
        const q = query.trim();
        if (!q) {
          setResults(null);
          return;
        }
        const wantType = overrideType === undefined ? typeFilter : overrideType;
        setBusy(true);
        setError("");
        try {
          const url = `${API}/knowledge/search?topK=12&q=${encodeURIComponent(q)}`
            + (project ? `&project=${encodeURIComponent(project)}` : "")
            + (wantType ? `&type=${encodeURIComponent(wantType)}` : "")
            + (includeWeb ? "&includeWeb=1" : "");
          setResults(await requestJson(url));
        } catch (e) {
          setError(e.message);
        } finally {
          setBusy(false);
        }
      }, [query, project, includeWeb, typeFilter]);

      // 外部传入检索词（洞察里点标签）时自动搜一次；只对"外部变化"触发，避免循环。
      const lastAutoQuery = useRef("");
      useEffect(() => {
        const next = String(queryProp ?? "").trim();
        if (!next || lastAutoQuery.current === next) return;
        lastAutoQuery.current = next;
        search();
      }, [queryProp, search]);

      const rows = results ? results.results : (data?.entries?.rows || []);
      const origins = results ? results.origins : ["local"];
      const badge = (origin) => origin && origin !== "local"
        ? React.createElement("span", { className: "_kb_badge", "data-origin": origin }, origin)
        : null;

      return React.createElement(React.Fragment, null,
        React.createElement("div", { className: "_kb_kbhead" },
          React.createElement("span", null, project ? `项目：${project}` : `全部项目（${data?.vault?.projectCount ?? 0}）`),
          project && React.createElement("button", { type: "button", onClick: () => { setResults(null); load(null); } }, "← 全部")),
        inbox && inbox.count > 0 && React.createElement("div", { className: "_kb_inbox" },
          React.createElement("div", { className: "_kb_kbhead" },
            React.createElement("span", null, `待审 ${inbox.count} 条`),
            React.createElement("button", { type: "button", disabled: inboxBusy, onClick: () => loadInbox() }, "刷新")),
          inbox.items.map((item) => React.createElement("div", { key: item.path, className: "_kb_inboxitem" },
            React.createElement("button", {
              type: "button",
              className: "_kb_kbrow",
              onClick: () => onOpen({ path: item.path, name: item.title }),
              title: item.path
            },
              React.createElement("span", { className: "_kb_kbrowtitle" }, item.title, badge(item.origin)),
              React.createElement("span", { className: "_kb_kbrowmeta" },
                [
                  item.confidence != null ? `conf ${item.confidence}` : null,
                  item.captured ? String(item.captured).slice(0, 10) : null,
                  (item.suggest || []).length ? `候选 ${item.suggest.length}` : "无候选"
                ].filter(Boolean).join(" · ")),
              item.summary && React.createElement("span", { className: "_kb_kbsnippet" }, item.summary)),
            React.createElement("div", { className: "_kb_inboxactions" },
              React.createElement("button", { type: "button", disabled: inboxBusy, onClick: () => inboxAction("promote", item), title: "归入正式目录（自动，刷新 INDEX.md）" }, "归库"),
              React.createElement("button", {
                type: "button",
                disabled: inboxBusy || !(item.suggest || []).length,
                onClick: () => inboxAction("merge", item, { into: item.suggest[0] }),
                title: (item.suggest || [])[0] ? `合并进 ${item.suggest[0]}` : "没有合并候选"
              }, "合并"),
              React.createElement("button", { type: "button", "data-danger": true, disabled: inboxBusy, onClick: () => inboxAction("drop", item, { reason: "panel" }), title: "丢弃到 Inbox/.dropped（可恢复）" }, "丢弃"))))),
        !project && (data?.projects || []).map((p) => React.createElement("button", {
          key: p.name,
          type: "button",
          className: "_kb_kbrow",
          onClick: () => { setResults(null); load(p.name); }
        },
          React.createElement("span", { className: "_kb_kbrowtitle" }, p.name),
          React.createElement("span", { className: "_kb_kbrowmeta" }, `${p.notes} 篇 · ${p.topics.length} 个主题${p.updated ? ` · 最近 ${p.updated}` : ""}`))),
        React.createElement("form", { onSubmit: search },
          React.createElement("div", { className: "_kb_searchbar" },
            React.createElement("input", {
              className: "_kb_searchinput",
              value: query,
              onChange: (event) => setQuery(event.target.value),
              placeholder: project ? `在 ${project} 内检索…` : "检索知识库…",
              "aria-label": "检索知识库"
            }),
            query && React.createElement("button", { className: "_kb_searchclear", type: "button", onClick: () => { setQuery(""); setResults(null); }, "aria-label": "清除" }, "×"))),
        React.createElement("label", { className: "_kb_kbcheck" },
          React.createElement("input", { type: "checkbox", checked: includeWeb, onChange: (event) => setIncludeWeb(event.target.checked) }),
          `含 web/inferred（当前只召回 ${origins.join("/")}）`),
        React.createElement("div", { className: "_kb_tags _kb_typefilter" },
          [
            ["", "全部"],
            ["note", "普通笔记"],
            ["card", "card"],
            ["memory", "memory"],
            ["wiki", "wiki"]
          ].map(([value, label]) => React.createElement("button", {
            key: value || "all",
            type: "button",
            className: "_kb_tag",
            "data-active": typeFilter === value,
            title: value === "note" ? "只召回没有 type 的普通笔记" : value ? `只召回 type: ${value}` : "不按 type 过滤",
            onClick: () => {
              setTypeFilter(value);
              if (query.trim()) search(null, value);
            }
          }, label))),
        error && React.createElement("div", { className: "_kb_error" }, error),
        busy && React.createElement("div", { className: "_kb_hint" }, "正在处理…"),
        !busy && rows.length === 0 && React.createElement("div", { className: "_kb_hint" }, results ? (results.note || "没有命中。") : "选择项目，或输入检索词。"),
        rows.map((row) => React.createElement("button", {
          key: row.path,
          type: "button",
          className: "_kb_kbrow",
          onClick: () => onOpen({ path: row.path, name: row.title || row.path.split("/").pop() }),
          title: row.path
        },
          React.createElement("span", { className: "_kb_kbrowtitle" }, row.title || row.path, badge(row.origin)),
          React.createElement("span", { className: "_kb_kbrowmeta" },
            [row.group, typeof row.score === "number" ? `score ${row.score}` : null, row.updated,
              (row.tags || []).slice(0, 3).map((t) => `#${t}`).join(" ")].filter(Boolean).join(" · ")),
          row.snippet && React.createElement("span", { className: "_kb_kbsnippet" }, row.snippet))));
    }

    // P5: 图谱布局 —— 确定性的 Fruchterman-Reingold（同步跑完，无动画），
    // 60 个节点 / 120 次迭代在面板里是毫秒级，比引入 d3 更划算。
    function layoutGraph(nodes, edges, width, height, iterations) {
      const n = nodes.length;
      const indexOf = new Map(nodes.map((node, i) => [node.path, i]));
      const k = Math.sqrt((width * height) / Math.max(1, n));
      const pos = nodes.map((_node, i) => {
        const angle = (i / Math.max(1, n)) * Math.PI * 2;
        const radius = Math.min(width, height) * 0.42;
        return { x: width / 2 + Math.cos(angle) * radius, y: height / 2 + Math.sin(angle) * radius };
      });
      const links = edges
        .map((edge) => [indexOf.get(edge.from), indexOf.get(edge.to)])
        .filter((pair) => pair[0] != null && pair[1] != null && pair[0] !== pair[1]);
      let temp = width / 8;
      for (let step = 0; step < iterations; step += 1) {
        const disp = pos.map(() => ({ x: 0, y: 0 }));
        for (let i = 0; i < n; i += 1) {
          for (let j = i + 1; j < n; j += 1) {
            let dx = pos[i].x - pos[j].x;
            let dy = pos[i].y - pos[j].y;
            let d = Math.hypot(dx, dy);
            if (d < 0.01) {
              dx = (i % 7) * 0.03 + 0.03;
              dy = (j % 5) * 0.03 + 0.03;
              d = Math.hypot(dx, dy);
            }
            const force = (k * k) / d;
            const ux = dx / d;
            const uy = dy / d;
            disp[i].x += ux * force;
            disp[i].y += uy * force;
            disp[j].x -= ux * force;
            disp[j].y -= uy * force;
          }
        }
        for (const [a, b] of links) {
          const dx = pos[a].x - pos[b].x;
          const dy = pos[a].y - pos[b].y;
          const d = Math.hypot(dx, dy) || 0.01;
          const force = (d * d) / k;
          const ux = dx / d;
          const uy = dy / d;
          disp[a].x -= ux * force;
          disp[a].y -= uy * force;
          disp[b].x += ux * force;
          disp[b].y += uy * force;
        }
        for (let i = 0; i < n; i += 1) {
          const d = Math.hypot(disp[i].x, disp[i].y) || 0.01;
          const limit = Math.min(d, temp);
          pos[i].x = Math.max(14, Math.min(width - 14, pos[i].x + (disp[i].x / d) * limit));
          pos[i].y = Math.max(14, Math.min(height - 14, pos[i].y + (disp[i].y / d) * limit));
        }
        temp = Math.max(0.6, temp * (1 - (step + 1) / iterations));
      }
      return { pos, links };
    }

    function GraphView({ graph, onOpen }) {
      const width = 292;
      const height = 210;
      const layout = useMemo(() => {
        if (!graph || !graph.nodes || graph.nodes.length === 0) return null;
        const nodes = graph.nodes.slice(0, 60);
        const kept = new Set(nodes.map((node) => node.path));
        const edges = (graph.edges || []).filter((edge) => kept.has(edge.from) && kept.has(edge.to));
        return Object.assign({ nodes }, layoutGraph(nodes, edges, width, height, 120));
      }, [graph]);
      if (!layout) return null;
      const radius = (node) => 3 + Math.min(9, node.degree);
      return React.createElement("svg", {
        className: "_kb_graph",
        viewBox: `0 0 ${width} ${height}`,
        preserveAspectRatio: "xMidYMid meet",
        role: "img"
      },
        layout.links.map(([a, b], i) => React.createElement("line", {
          key: `e${i}`,
          className: "_kb_graphedge",
          x1: layout.pos[a].x,
          y1: layout.pos[a].y,
          x2: layout.pos[b].x,
          y2: layout.pos[b].y
        })),
        layout.nodes.map((node, i) => React.createElement("g", {
          key: node.path,
          className: "_kb_graphnode",
          transform: `translate(${layout.pos[i].x} ${layout.pos[i].y})`,
          onClick: () => onOpen && onOpen({ path: node.path, name: node.title || String(node.path).split("/").pop() })
        },
          React.createElement("title", null, `${node.title || node.path}\n${node.path}\n出链 ${node.out} / 入链 ${node.in}`),
          React.createElement("circle", { r: radius(node) }),
          node.degree >= 3 && React.createElement("text", {
            className: "_kb_graphlabel",
            x: radius(node) + 3,
            y: 3
          }, String(node.title || node.path).slice(0, 14)))));
    }

    // dsh-kb: 「洞察」面板 —— 标签云 / 库体检 / 当前笔记的反链与相关。
    function InsightPanel({ onOpen, notePath, onTagClick }) {
      const [cloud, setCloud] = useState(null);
      const [doctor, setDoctor] = useState(null);
      const [links, setLinks] = useState(null);
      const [graph, setGraph] = useState(null);
      const [gaps, setGaps] = useState(null);
      const [notice, setNotice] = useState("");
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState("");

      const load = useCallback(async () => {
        setBusy(true);
        setError("");
        try {
          const [c, d, g, p] = await Promise.all([
            requestJson(`${API}/knowledge/tagcloud`),
            requestJson(`${API}/knowledge/doctor`),
            requestJson(`${API}/knowledge/graph?limit=60`),
            requestJson(`${API}/knowledge/gaps`)
          ]);
          setCloud(c);
          setDoctor(d);
          setGraph(g);
          setGaps(p);
        } catch (e) {
          setError(e.message);
        } finally {
          setBusy(false);
        }
      }, []);

      const resolveGap = useCallback(async (gap) => {
        const note = typeof window !== "undefined" && window.prompt
          ? window.prompt(`「${gap.question}」补到了哪篇笔记 / 怎么补的？`, "")
          : null;
        setBusy(true);
        try {
          await requestJson(`${API}/knowledge/gaps`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "resolve", project: gap.project, id: gap.id, note: note || null })
          });
          setGaps(await requestJson(`${API}/knowledge/gaps`));
        } catch (e) {
          setError(e.message);
        } finally {
          setBusy(false);
        }
      }, []);

      useEffect(() => {
        if (!cloud) load();
      }, [cloud, load]);

      useEffect(() => {
        if (!notePath) {
          setLinks(null);
          return undefined;
        }
        let alive = true;
        requestJson(`${API}/knowledge/links?max=12&path=${encodeURIComponent(notePath)}`)
          .then((payload) => {
            if (alive) setLinks(payload);
          })
          .catch(() => {
            if (alive) setLinks(null);
          });
        return () => {
          alive = false;
        };
      }, [notePath]);

      const rebuildIndexes = useCallback(async () => {
        setBusy(true);
        setError("");
        try {
          const out = await requestJson(`${API}/knowledge/reindex`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ fixIndexes: true })
          });
          setNotice(`索引已重建：${out.notes} 篇，刷新 ${out.fixed.length} 个项目索引`);
          setGaps(await requestJson(`${API}/knowledge/gaps`));
          setDoctor(await requestJson(`${API}/knowledge/doctor`));
        } catch (e) {
          setError(e.message);
        } finally {
          setBusy(false);
        }
      }, []);

      const levelLabel = { error: "错误", warn: "警告", info: "提示" };
      const linkRows = links
        ? [
            ...(links.backlinks || []).map((row) => Object.assign({}, row, { kind: "←" })),
            ...(links.related || []).map((row) => Object.assign({}, row, { kind: "≈" }))
          ].slice(0, 20)
        : [];

      return React.createElement(React.Fragment, null,
        React.createElement("div", { className: "_kb_kbhead" },
          React.createElement("span", null, `洞察${doctor ? ` · ${doctor.scanned} 篇` : ""}`),
          React.createElement("button", { type: "button", disabled: busy, onClick: () => load() }, "刷新")),
        error && React.createElement("div", { className: "_kb_error" }, error),
        notice && React.createElement("div", { className: "_kb_hint" }, notice),
        cloud && cloud.tags.length > 0 && React.createElement("div", { className: "_kb_insightbox" },
          React.createElement("div", { className: "_kb_sectionlabel" }, `标签（${cloud.total}）`),
          React.createElement("div", { className: "_kb_tags" },
            cloud.tags.slice(0, 40).map((t) => React.createElement("button", {
              key: t.tag,
              type: "button",
              className: "_kb_tag",
              title: `在「知识」里检索 ${t.tag}`,
              onClick: () => onTagClick && onTagClick(t.tag)
            }, `${t.tag} ${t.count}`)))),
        graph && graph.nodeCount > 0 && React.createElement("div", { className: "_kb_insightbox" },
          React.createElement("div", { className: "_kb_sectionlabel" },
            `图谱 · ${graph.nodeCount} 节点 / ${graph.edgeCount} 链接 / ${graph.isolated} 孤立`),
          React.createElement(GraphView, { graph, onOpen }),
          graph.isolated > 0 && React.createElement("div", { className: "_kb_hint" },
            `${graph.isolated} 篇没有被任何笔记引用，也没有出链 —— 考虑补 wikilink 把它们接进网络。`)),
        gaps && gaps.count > 0 && React.createElement("div", { className: "_kb_insightbox" },
          React.createElement("div", { className: "_kb_sectionlabel" },
            `缺口 · 未补 ${gaps.open} / 共 ${gaps.count}`),
          gaps.items.filter((gap) => !gap.done).slice(0, 30).map((gap) => React.createElement("div", {
            key: `${gap.project}-${gap.id}`,
            className: "_kb_gapitem"
          },
            React.createElement("span", { title: `${gap.path}　${gap.clues || ""}　${gap.source || ""}` },
              `[${gap.project}] ${gap.question}`),
            React.createElement("button", {
              type: "button",
              disabled: busy,
              title: "补齐后勾掉这条缺口",
              onClick: () => resolveGap(gap)
            }, "补上"))),
          gaps.open === 0 && React.createElement("div", { className: "_kb_hint" }, "缺口都补齐了。"),
          gaps.done > 0 && React.createElement("div", { className: "_kb_hint" },
            `已补 ${gaps.done} 条：`,
            gaps.items.filter((gap) => gap.done).slice(0, 10).map((gap) => React.createElement("span", {
              key: `d-${gap.project}-${gap.id}`,
              className: "_kb_gapdone"
            }, `　✓ ${gap.question}`)))),
        doctor && React.createElement("div", { className: "_kb_insightbox" },
          React.createElement("div", { className: "_kb_sectionlabel" },
            `体检 · 错误 ${doctor.errors} / 警告 ${doctor.warns} / 提示 ${doctor.infos}`),
          React.createElement("div", { className: "_kb_inboxactions" },
            React.createElement("button", {
              type: "button",
              disabled: busy,
              title: "强制全量重建索引，并重写落后/缺失的项目 INDEX.md（只动派生文件）",
              onClick: () => rebuildIndexes()
            }, "重建索引")),
          doctor.problems.length === 0
            ? React.createElement("div", { className: "_kb_hint" }, "没有问题，库很干净。")
            : doctor.problems.slice(0, 40).map((p, i) => React.createElement("button", {
                key: `${p.path}-${i}`,
                type: "button",
                className: "_kb_kbrow",
                title: p.path,
                onClick: () => onOpen({ path: String(p.path).split(" / ")[0], name: String(p.path).split("/").pop() })
              },
                React.createElement("span", { className: "_kb_kbrowtitle" }, `${levelLabel[p.level] || p.level}：${p.issue}`),
                React.createElement("span", { className: "_kb_kbrowmeta" }, p.path)))),
        notePath && React.createElement("div", { className: "_kb_insightbox" },
          React.createElement("div", { className: "_kb_sectionlabel" },
            links ? `当前笔记 · 反链 ${(links.backlinks || []).length} / 相关 ${(links.related || []).length}` : "当前笔记 · 关联"),
          linkRows.length === 0
            ? React.createElement("div", { className: "_kb_hint" }, "没有反链或相关笔记。")
            : linkRows.map((row, i) => React.createElement("button", {
                key: `${row.path}-${i}`,
                type: "button",
                className: "_kb_kbrow",
                title: row.path,
                onClick: () => onOpen({ path: row.path, name: row.title || String(row.path).split("/").pop() })
              },
                React.createElement("span", { className: "_kb_kbrowtitle" }, `${row.kind} ${row.title || row.path}`),
                React.createElement("span", { className: "_kb_kbrowmeta" }, row.relation ? `${row.relation} · ${row.path}` : row.path)))));
    }

    // dsh-kb: 「代码」面板 —— RepoWiki（扫仓库 / 同步 / 概览 / 依赖图 / 页面清单）。
    // 「AI 凝练」不在这里：它由 agent 读骨架后调 `kb_wiki_upsert` 回填（面板只显示
    // 每页的 analysisLevel，告诉你哪些页还是骨架）。
    function WikiPanel({ onOpen }) {
      const [repos, setRepos] = useState([]);
      const [repo, setRepo] = useState("");
      const [entries, setEntries] = useState([]);
      const [graph, setGraph] = useState(null);
      const [overview, setOverview] = useState(null);
      const [form, setForm] = useState({ repoPath: "", repoName: "", maxFiles: "40" });
      const [busy, setBusy] = useState("");
      const [error, setError] = useState("");
      const [notice, setNotice] = useState("");

      const loadRepo = useCallback(async (name) => {
        if (!name) {
          setEntries([]);
          setGraph(null);
          setOverview(null);
          return;
        }
        const query = encodeURIComponent(name);
        const [list, g, o] = await Promise.all([
          requestJson(`${API}/wiki/list?repo=${query}`),
          requestJson(`${API}/wiki/graph?repo=${query}`).catch(() => null),
          requestJson(`${API}/wiki/overview?repo=${query}`).catch(() => null)
        ]);
        setEntries(list.entries || []);
        setGraph(g);
        setOverview(o);
      }, []);

      const refresh = useCallback(async (prefer) => {
        setBusy("读取");
        setError("");
        try {
          const payload = await requestJson(`${API}/wiki/repos`);
          const list = payload.repos || [];
          setRepos(list);
          const next = prefer && list.includes(prefer) ? prefer : repo && list.includes(repo) ? repo : list[0] || "";
          setRepo(next);
          await loadRepo(next);
        } catch (e) {
          setError(e.message);
        } finally {
          setBusy("");
        }
      }, [loadRepo, repo]);

      useEffect(() => {
        refresh("");
        // 只在首次挂载时读一次；之后的刷新都由按钮触发。
      }, []);

      const post = useCallback(async (endpoint, payload, label) => {
        setBusy(label);
        setError("");
        setNotice("");
        try {
          const out = await requestJson(`${API}${endpoint}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload)
          });
          if (out.added) {
            setNotice(`${label}完成：新增 ${out.added.length} / 变更 ${out.changed?.length ?? 0} / 保留 ${out.preserved?.length ?? 0} / 剪除 ${out.pruned?.length ?? 0}${out.pruneSkipped ? `（${out.pruneSkipped}）` : ""}`);
          } else if (typeof out.count === "number") {
            setNotice(`${label}完成：写入 ${out.count} 页 / 跳过 ${out.skipped ?? 0} 页已存在${out.index ? "；INDEX.md 已刷新" : ""}`);
          } else {
            setNotice(`${label}完成`);
          }
          await refresh(out.repo || preferName(payload));
        } catch (e) {
          setError(e.message);
        } finally {
          setBusy("");
        }
      }, [refresh]);

      function preferName(payload) {
        const raw = String(payload?.repoName || payload?.repoPath || "").replace(/[/\\]+$/, "");
        return raw.split(/[/\\]/).pop() || "";
      }

      const wikiNodes = useMemo(() => {
        if (!graph || !graph.nodes) return null;
        const callers = graph.callers || {};
        const outs = new Map();
        for (const edge of graph.edges || []) outs.set(edge.from, (outs.get(edge.from) || 0) + 1);
        const nodes = graph.nodes.map((node) => {
          const inbound = callers[node.path] || 0;
          const outbound = outs.get(node.path) || 0;
          return {
            path: node.path,
            rel: node.rel,
            title: node.title || node.path,
            group: String(node.path).split("/").slice(0, -1).join("/") || "（根）",
            in: inbound,
            out: outbound,
            degree: inbound + outbound,
            symbols: (node.symbols || []).length
          };
        }).sort((a, b) => b.degree - a.degree || a.path.localeCompare(b.path));
        return {
          nodes,
          edges: (graph.edges || []).map((edge) => ({ from: edge.from, to: edge.to })),
          nodeCount: nodes.length,
          edgeCount: (graph.edges || []).length,
          isolated: nodes.filter((node) => node.degree === 0).length
        };
      }, [graph]);

      const skeletonPages = entries.filter((entry) => (entry.analysisLevel ?? "skeleton") === "skeleton").length;
      const levelBadge = { skeleton: "骨架", ai: "AI", manual: "人工" };
      const overviewLines = String(overview?.body || "").split("\n").slice(0, 26).join("\n");

      return React.createElement(React.Fragment, null,
        React.createElement("div", { className: "_kb_kbhead" },
          React.createElement("span", null, `代码仓库${repo ? ` · ${repo}` : ""}`),
          React.createElement("button", { type: "button", disabled: Boolean(busy), onClick: () => refresh(repo) }, busy || "刷新")),
        error && React.createElement("div", { className: "_kb_error" }, error),
        notice && React.createElement("div", { className: "_kb_hint" }, notice),
        React.createElement("div", { className: "_kb_insightbox" },
          React.createElement("div", { className: "_kb_sectionlabel" }, "扫描 / 同步本地仓库"),
          React.createElement("div", { className: "_kb_wikiform" },
            React.createElement("input", {
              className: "_kb_wikiinput",
              value: form.repoPath,
              placeholder: "仓库绝对路径，如 D:\\code\\my-repo",
              onChange: (event) => setForm({ ...form, repoPath: event.target.value })
            }),
            React.createElement("input", {
              className: "_kb_wikiinput",
              value: form.repoName,
              placeholder: "仓库名（默认取目录名；同时是 vault 里的项目名）",
              onChange: (event) => setForm({ ...form, repoName: event.target.value })
            }),
            React.createElement("input", {
              className: "_kb_wikiinput",
              value: form.maxFiles,
              placeholder: "最多文件数（默认 40）",
              onChange: (event) => setForm({ ...form, maxFiles: event.target.value })
            }),
            React.createElement("div", { className: "_kb_inboxactions" },
              React.createElement("button", {
                type: "button",
                disabled: Boolean(busy) || !form.repoPath.trim(),
                title: "为仓库里每个源文件生成一张 Wiki 骨架卡（原地写进 vault）",
                onClick: () => post("/wiki/scan", { repoPath: form.repoPath.trim(), repoName: form.repoName.trim(), maxFiles: Number(form.maxFiles) || undefined }, "扫描")
              }, "扫描仓库"),
              React.createElement("button", {
                type: "button",
                disabled: Boolean(busy) || !form.repoPath.trim() || !repos.length,
                title: "以磁盘为准双向对账：新增/变更/剪除孤儿（已语义回填的页受保护）",
                onClick: () => post("/wiki/sync", { repoPath: form.repoPath.trim(), repoName: form.repoName.trim() || repo, maxFiles: Number(form.maxFiles) || undefined }, "同步")
              }, "同步")),
            React.createElement("div", { className: "_kb_hint" }, "扫描/同步会直接在 vault 里建或改 wiki 页（你的点击即同意）。「AI 凝练」由 agent 读骨架后用 kb_wiki_upsert 回填。"))),
        repos.length > 0 && React.createElement("div", { className: "_kb_insightbox" },
          React.createElement("div", { className: "_kb_sectionlabel" }, `已收录仓库（${repos.length}）`),
          React.createElement("div", { className: "_kb_tags" },
            repos.map((name) => React.createElement("button", {
              key: name,
              type: "button",
              className: "_kb_tag",
              "data-active": name === repo,
              onClick: () => { setRepo(name); loadRepo(name).catch((e) => setError(e.message)); }
            }, name)))),
        repo && React.createElement("div", { className: "_kb_insightbox" },
          React.createElement("div", { className: "_kb_sectionlabel" },
            `页面 ${entries.length}${skeletonPages ? ` · 待凝练 ${skeletonPages}` : ""}`),
          skeletonPages > 0 && React.createElement("div", { className: "_kb_hint" },
            `还有 ${skeletonPages} 页是骨架 —— 让 agent 读完后用 kb_wiki_upsert 回填语义描述。`),
          entries.slice(0, 40).map((entry, i) => React.createElement("button", {
            key: entry.rel || i,
            type: "button",
            className: "_kb_kbrow",
            title: entry.rel,
            onClick: () => onOpen({ path: entry.rel, name: entry.title || entry.path || entry.rel })
          },
            React.createElement("span", { className: "_kb_kbrowtitle" },
              entry.title || entry.path || entry.rel,
              React.createElement("span", { className: "_kb_badge", "data-origin": "local" }, levelBadge[entry.analysisLevel] || entry.analysisLevel || "骨架")),
            React.createElement("span", { className: "_kb_kbrowmeta" }, entry.path || entry.rel)))),
        wikiNodes && wikiNodes.nodeCount > 0 && React.createElement("div", { className: "_kb_insightbox" },
          React.createElement("div", { className: "_kb_sectionlabel" },
            `依赖图 · ${wikiNodes.nodeCount} 模块 / ${wikiNodes.edgeCount} 条 import 边 / ${wikiNodes.isolated} 孤立`),
          React.createElement(GraphView, { graph: wikiNodes, onOpen: (target) => onOpen({ path: target.rel || target.path, name: target.name }) })),
        repo && React.createElement("div", { className: "_kb_insightbox" },
          React.createElement("div", { className: "_kb_sectionlabel" }, "项目概览"),
          React.createElement("div", { className: "_kb_inboxactions" },
            React.createElement("button", {
              type: "button",
              disabled: Boolean(busy),
              title: "重新生成 <repo>/project-overview.md（体量/目录/语言/核心模块/页面清单）",
              onClick: () => post("/wiki/overview", { repo }, "概览")
            }, "刷新概览")),
          overviewLines
            ? React.createElement("pre", { className: "_kb_wikibody" }, overviewLines)
            : React.createElement("div", { className: "_kb_hint" }, "还没有概览页，点「刷新概览」生成。")));
    }

    function Workbench({ onClose, sessions, workspaces, modelDirectories }) {
      const [meta, setMeta] = useState(null);
      const [metaError, setMetaError] = useState("");
      const [selected, setSelected] = useState("");
      const [note, setNote] = useState(null);
      const [editor, setEditor] = useState("");
      const [saving, setSaving] = useState(false);
      const [status, setStatus] = useState("就绪");
      const [widths, setWidths] = useState({ left: 280, right: 360 });
      const [drag, setDrag] = useState(null);
      const [treeRevision, setTreeRevision] = useState(0);
      const [moving, setMoving] = useState(null);
      const [dropTargetPath, setDropTargetPath] = useState("");
      const [focusedFolder, setFocusedFolder] = useState("");
      const [treeActionError, setTreeActionError] = useState("");
      const [contextMenu, setContextMenu] = useState(null);
      const [chatInsertRequest, setChatInsertRequest] = useState(null);
      const [nameDialog, setNameDialog] = useState(null);
      const [nameValue, setNameValue] = useState("");
      const [titleEditing, setTitleEditing] = useState(false);
      const [titleValue, setTitleValue] = useState("");
      const [deleteDialog, setDeleteDialog] = useState(null);
      const [searchQuery, setSearchQuery] = useState("");
      const [searchResults, setSearchResults] = useState(null);
      const [searching, setSearching] = useState(false);
      const [lastDelete, setLastDelete] = useState(null);
      const [leftView, setLeftView] = useState("files");
      const [kbQuery, setKbQuery] = useState("");
      const rootRef = useRef(null);
      const saveTimerRef = useRef(null);
      const savePromiseRef = useRef(null);
      const saveRef = useRef(null);
      const titleInputRef = useRef(null);
      const titleEditingRef = useRef(false);

      useEffect(() => {
        requestJson(`${API}/meta`).then(setMeta).catch((e) => setMetaError(e.message));
        rootRef.current?.focus();
      }, []);

      useEffect(() => {
        if (titleEditing) {
          titleInputRef.current?.focus();
          titleInputRef.current?.select();
        }
      }, [titleEditing]);

      useEffect(() => {
        if (!note || note.image) {
          titleEditingRef.current = false;
          setTitleEditing(false);
          return;
        }
        if (!titleEditing) setTitleValue(note.name || "");
      }, [note?.path, note?.name, note?.image, titleEditing]);

      useEffect(() => {
        const query = searchQuery.trim();
        if (!query) {
          setSearchResults(null);
          setSearching(false);
          return undefined;
        }
        setSearching(true);
        const timer = window.setTimeout(() => {
          requestJson(`${API}/search?q=${encodeURIComponent(query)}`)
            .then((payload) => setSearchResults(payload))
            .catch((error) => setSearchResults({ error: error.message }))
            .finally(() => setSearching(false));
        }, 220);
        return () => window.clearTimeout(timer);
      }, [searchQuery]);

      useEffect(() => {
        if (!drag) return undefined;
        const move = (event) => {
          const delta = event.clientX - drag.startX;
          if (drag.side === "left") {
            setWidths((value) => ({ ...value, left: Math.max(220, Math.min(460, drag.startLeft + delta)) }));
          } else {
            setWidths((value) => ({ ...value, right: Math.max(280, Math.min(560, drag.startRight - delta)) }));
          }
        };
        const stop = () => setDrag(null);
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", stop);
        window.addEventListener("pointercancel", stop);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        return () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", stop);
          window.removeEventListener("pointercancel", stop);
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
        };
      }, [drag]);

      const startResize = (side, event) => {
        event.preventDefault();
        setDrag({ side, startX: event.clientX, startLeft: widths.left, startRight: widths.right });
      };

      const openFile = async (entry) => {
        const saved = await saveRef.current?.();
        if (saved === false) return;
        if (entry.kind === "image") {
          setSelected(entry.path);
          setNote({ path: entry.path, name: entry.name, image: true });
          setStatus("已打开附件");
          return;
        }
        try {
          setStatus("正在读取…");
          const payload = await requestJson(`${API}/file?path=${encodeURIComponent(entry.path)}`);
          setSelected(entry.path);
          setNote(payload);
          setEditor(payload.content);
          setStatus("已加载");
        } catch (e) {
          setStatus(e.message);
        }
      };
      const openSearchResult = async (entry) => {
        setSearchQuery("");
        setSearchResults(null);
        await openFile(entry);
      };

      const save = async ({ auto = false } = {}) => {
        if (!note?.path || note.image || note.content === editor) return true;
        if (savePromiseRef.current) return savePromiseRef.current;
        const path = note.path;
        const content = editor;
        const run = (async () => {
          setSaving(true);
          setStatus(auto ? "自动保存中…" : "保存中…");
          try {
            const payload = await requestJson(`${API}/save`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ path, content })
            });
            setNote((value) => value?.path === path ? { ...value, content, modifiedAt: payload.modifiedAt } : value);
            setStatus(auto ? "已自动保存" : "已保存");
            return true;
          } catch (e) {
            setStatus(e.message);
            return false;
          } finally {
            setSaving(false);
          }
        })();
        savePromiseRef.current = run;
        try {
          return await run;
        } finally {
          if (savePromiseRef.current === run) savePromiseRef.current = null;
        }
      };
      saveRef.current = save;

      useEffect(() => {
        if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
        if (!note || note.image || note.content === editor) return undefined;
        saveTimerRef.current = window.setTimeout(() => {
          saveRef.current?.({ auto: true });
        }, 800);
        return () => {
          if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
          saveTimerRef.current = null;
        };
      }, [editor, note?.path, note?.content, note?.image]);

      const refreshTree = () => setTreeRevision((value) => value + 1);
      const newItemParent = () => {
        if (focusedFolder) return focusedFolder;
        const slash = selected.lastIndexOf("/");
        return slash === -1 ? "" : selected.slice(0, slash);
      };
      const parentForEntry = (entry) => {
        if (!entry) return newItemParent();
        if (entry.kind === "directory") return entry.path;
        const slash = entry.path.lastIndexOf("/");
        return slash === -1 ? "" : entry.path.slice(0, slash);
      };
      const openNameDialog = (kind, parent) => {
        setContextMenu(null);
        setNameValue(kind === "folder" ? "新文件夹" : "未命名笔记");
        setNameDialog({ kind, parent });
      };
      const createFolderAt = async (parent, name) => {
        if (!name) return;
        const saved = await saveRef.current?.();
        if (saved === false) return;
        setTreeActionError("");
        try {
          const payload = await requestJson(`${API}/create-folder`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ parent, name })
          });
          setFocusedFolder(payload.path);
          refreshTree();
          setStatus("文件夹已创建");
        } catch (e) {
          setTreeActionError(e.message);
          setStatus(e.message);
        }
      };
      const createNoteAt = async (parent, name) => {
        if (!name) return;
        const saved = await saveRef.current?.();
        if (saved === false) return;
        setTreeActionError("");
        try {
          const payload = await requestJson(`${API}/create-note`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ parent, name, content: "" })
          });
          refreshTree();
          setStatus("笔记已创建");
          await openFile({ path: payload.path, name: payload.name, kind: "file" });
        } catch (e) {
          setTreeActionError(e.message);
          setStatus(e.message);
        }
      };
      const submitName = async (event) => {
        event.preventDefault();
        const name = nameValue.trim();
        if (!name || !nameDialog) return;
        const dialog = nameDialog;
        setNameDialog(null);
        if (dialog.kind === "folder") await createFolderAt(dialog.parent, name);
        else if (dialog.kind === "note") await createNoteAt(dialog.parent, name);
        else await renameEntry(dialog.entry, name);
      };
      const openRenameDialog = (entry) => {
        setContextMenu(null);
        setNameValue(entry.name);
        setNameDialog({ kind: "rename", entry });
      };
      const beginTitleEdit = () => {
        if (!note || note.image) return;
        titleEditingRef.current = true;
        setTitleValue(note.name || "");
        setTitleEditing(true);
      };
      const renameEntry = async (entry, name) => {
        if (!entry || !name) return;
        const saved = await saveRef.current?.();
        if (saved === false) return;
        setTreeActionError("");
        try {
          const payload = await requestJson(`${API}/rename`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: entry.path, name })
          });
          const source = entry.path;
          const nextPath = (value) => {
            if (!value) return value;
            if (value === source) return payload.path;
            return value.startsWith(`${source}/`) ? `${payload.path}${value.slice(source.length)}` : value;
          };
          setSelected(nextPath);
          setFocusedFolder((value) => nextPath(value));
          setNote((value) => value?.path ? { ...value, path: nextPath(value.path), name: value.path === source ? payload.name : value.name } : value);
          refreshTree();
          setStatus("已重命名");
        } catch (e) {
          setTreeActionError(e.message);
          setStatus(e.message);
        }
      };
      const finishTitleEdit = async (cancel = false) => {
        if (!titleEditingRef.current) return;
        titleEditingRef.current = false;
        setTitleEditing(false);
        const currentNote = note;
        const nextName = titleValue.trim();
        if (cancel || !currentNote || currentNote.image || !nextName || nextName === currentNote.name) {
          if (!cancel && currentNote) setTitleValue(currentNote.name || "");
          return;
        }
        await renameEntry(currentNote, nextName);
      };
      const askDelete = (entry) => {
        setContextMenu(null);
        setDeleteDialog(entry);
      };
      const deleteEntry = async (entry) => {
        if (!entry) return;
        const saved = await saveRef.current?.();
        if (saved === false) return;
        setTreeActionError("");
        try {
          const payload = await requestJson(`${API}/delete`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: entry.path })
          });
          const deletedPath = entry.path;
          if (selected === deletedPath || selected.startsWith(`${deletedPath}/`)) {
            setSelected("");
            setNote(null);
            setEditor("");
          }
          setLastDelete({ id: payload.undoId, name: entry.name });
          if (focusedFolder === deletedPath || focusedFolder.startsWith(`${deletedPath}/`)) setFocusedFolder("");
          refreshTree();
          setStatus("已删除");
        } catch (e) {
          setTreeActionError(e.message);
          setStatus(e.message);
        }
      };
      const undoDelete = async () => {
        if (!lastDelete?.id) return;
        setTreeActionError("");
        try {
          await requestJson(`${API}/undo-delete`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: lastDelete.id })
          });
          setLastDelete(null);
          refreshTree();
          setStatus("已撤销删除");
        } catch (e) {
          setTreeActionError(e.message);
          setStatus(e.message);
        }
      };
      const confirmDelete = async () => {
        const target = deleteDialog;
        setDeleteDialog(null);
        await deleteEntry(target);
      };
      const openContextMenu = (event, entry = null) => {
        event.preventDefault();
        event.stopPropagation();
        if (entry?.kind === "directory") setFocusedFolder(entry.path);
        const width = 220;
        const height = entry ? 300 : 100;
        setContextMenu({
          x: Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8)),
          y: Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8)),
          entry,
          parent: parentForEntry(entry)
        });
      };
      const closeContextMenuOutside = (event) => {
        if (contextMenu && !event.target.closest?.("._kb_contextmenu")) setContextMenu(null);
      };
      const startMove = (entry) => {
        setTreeActionError("");
        setContextMenu(null);
        setMoving({ entry });
        setDropTargetPath("");
        setStatus(`正在移动「${entry.name}」，请选择目标文件夹`);
      };
      const addToChat = async (entry) => {
        setContextMenu(null);
        if (!entry?.path) return;
        if (await saveRef.current?.() === false) return;
        try {
          setStatus(`正在整理「${entry.name}」的上下文…`);
          const payload = await requestJson(`${API}/context?path=${encodeURIComponent(entry.path)}`);
          const suffix = payload.truncated ? "（内容较多，已截取前一部分）" : "";
          setChatInsertRequest({
            id: Date.now(),
            name: entry.name,
            path: payload.path || entry.path,
            kind: payload.kind || entry.kind,
            content: payload.content,
            truncated: payload.truncated,
            fileCount: payload.files?.length || 0
          });
          setStatus(`已加入对话：${entry.name}${suffix}`);
        } catch (error) {
          setTreeActionError(error.message);
          setStatus(error.message);
        }
      };
      const cancelMove = () => {
        setMoving(null);
        setDropTargetPath("");
        setStatus("已取消移动");
      };
      const hoverMoveTarget = (entry) => {
        if (!moving?.entry) return;
        if (moving.entry.path === entry.path) {
          setDropTargetPath("");
          return;
        }
        setDropTargetPath(entry.path);
        setStatus(`移动「${moving.entry.name}」到「${entry.name}」`);
      };
      const moveTo = async (destination) => {
        if (!moving?.entry) return;
        if (await saveRef.current?.() === false) return;
        const source = moving.entry.path;
        const destinationPath = typeof destination === "string" ? destination : destination?.path || "";
        setTreeActionError("");
        try {
          const payload = await requestJson(`${API}/move`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ source, destination: destinationPath })
          });
          const nextPath = (value) => {
            if (!value) return value;
            if (value === source) return payload.path;
            return value.startsWith(`${source}/`) ? `${payload.path}${value.slice(source.length)}` : value;
          };
          setSelected(nextPath);
          setNote((value) => value?.path ? { ...value, path: nextPath(value.path) } : value);
          setMoving(null);
          setDropTargetPath("");
          refreshTree();
          setStatus("已移动");
        } catch (e) {
          setTreeActionError(e.message);
          setStatus(e.message);
        }
      };
      const closeWorkbench = async () => {
        if (await saveRef.current?.() === false) return;
        onClose();
      };
      const onKeyDown = (event) => {
        if (event.key === "Escape") {
          if (deleteDialog) setDeleteDialog(null);
          else if (nameDialog) setNameDialog(null);
          else if (contextMenu) setContextMenu(null);
          else if (moving) cancelMove();
          else closeWorkbench();
          return;
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          save({ auto: false });
        }
      };

      const vaultName = meta?.vault?.name || "Obsidian";
      return React.createElement("div", {
        className: "_kb_overlay",
        ref: rootRef,
        tabIndex: -1,
        onKeyDown,
        onPointerDown: closeContextMenuOutside,
        style: { paddingTop: `${TITLEBAR_INSET}px`, gridTemplateColumns: `${widths.left}px 1px minmax(360px, 1fr) 1px ${widths.right}px` }
      },
        React.createElement("aside", { className: "_kb_left" },
          React.createElement("div", { className: "_kb_topbar" },
            React.createElement("div", { className: "_kb_vaultmark" }, React.createElement(ObsidianIcon, { idPrefix: "vault" })),
            React.createElement("div", { className: "_kb_title" },
              React.createElement("strong", null, vaultName),
              React.createElement("span", null, meta?.vault?.path || "正在读取仓库路径…")),
          React.createElement("button", { className: "_kb_iconbtn", type: "button", title: "关闭工作台", onClick: closeWorkbench }, "×")),
          React.createElement("div", { className: "_kb_leftbody", onContextMenu: (event) => openContextMenu(event, null) },
            React.createElement("div", { className: "_kb_switch" },
              React.createElement("button", { className: "_kb_switchbtn", type: "button", "data-active": leftView === "files", onClick: () => setLeftView("files") }, "文件"),
              React.createElement("button", { className: "_kb_switchbtn", type: "button", "data-active": leftView === "knowledge", onClick: () => setLeftView("knowledge") }, "知识"),
              React.createElement("button", { className: "_kb_switchbtn", type: "button", "data-active": leftView === "insight", onClick: () => setLeftView("insight") }, "洞察"),
              React.createElement("button", { className: "_kb_switchbtn", type: "button", "data-active": leftView === "code", onClick: () => setLeftView("code") }, "代码")),
            leftView === "code" && React.createElement(PanelBoundary, { label: "代码" },
              React.createElement(WikiPanel, { onOpen: openFile })),
            leftView === "knowledge" && React.createElement(PanelBoundary, { label: "知识" },
              React.createElement(KnowledgePanel, { onOpen: openFile, query: kbQuery, onQueryChange: setKbQuery })),
            leftView === "insight" && React.createElement(PanelBoundary, { label: "洞察" },
              React.createElement(InsightPanel, {
                onOpen: openFile,
                notePath: note && note.path,
                onTagClick: (tag) => { setKbQuery(tag); setLeftView("knowledge"); }
              })),
            leftView === "files" && React.createElement("div", { className: "_kb_sectionhead" },
              React.createElement("div", { className: "_kb_sectionlabel" }, "仓库")),
            leftView === "files" && React.createElement("div", { className: "_kb_searchbar" },
              React.createElement("input", { className: "_kb_searchinput", value: searchQuery, onChange: (event) => setSearchQuery(event.target.value), placeholder: "搜索仓库…", "aria-label": "搜索仓库" }),
              searchQuery && React.createElement("button", { className: "_kb_searchclear", type: "button", onClick: () => setSearchQuery(""), "aria-label": "清除搜索" }, "×")),
            leftView === "files" && lastDelete && React.createElement("div", { className: "_kb_undobar" },
              React.createElement("span", null, `已移到回收站：${lastDelete.name}`),
              React.createElement("button", { className: "_kb_undobutton", type: "button", onClick: undoDelete }, "撤销")),
            leftView === "files" && moving && React.createElement("div", { className: "_kb_movebar", "data-dragging": Boolean(dropTargetPath) },
              React.createElement("div", { className: "_kb_moveinfo" },
                React.createElement("strong", null, `移动：${moving.entry.name}`),
                React.createElement("span", null, dropTargetPath ? `放入「${dropTargetPath.split("/").pop()}」` : "按住拖到目标文件夹")),
              React.createElement("button", { className: "_kb_moveaction", type: "button", onClick: () => moveTo("") }, "移到根目录"),
              React.createElement("button", { className: "_kb_moveaction", type: "button", onClick: cancelMove }, "取消")),
            leftView === "files" && treeActionError && React.createElement("div", { className: "_kb_error" }, treeActionError),
            leftView === "files" && React.createElement(PanelBoundary, { label: "文件" },
              metaError ? React.createElement("div", { className: "_kb_error" }, metaError) : !meta?.configured ? React.createElement("div", { className: "_kb_hint" }, "没有找到本机 Obsidian 仓库。可以通过 OBSIDIAN_VAULT_PATH 指定路径。") : searchQuery.trim() ? React.createElement(SearchResults, { payload: searchResults, loading: searching, onOpen: openSearchResult }) : React.createElement(VaultTree, { selected, onOpen: openFile, revision: treeRevision, movingEntry: moving?.entry, dropTargetPath, onMoveStart: startMove, onMoveTarget: moveTo, onMoveHover: hoverMoveTarget, onMoveCancel: cancelMove, onFolderFocus: setFocusedFolder, onContextMenu: openContextMenu })))),
        React.createElement(ResizeHandle, { side: "left", dragging: drag?.side === "left", onPointerDown: startResize }),
          React.createElement("main", { className: "_kb_center" },
            React.createElement("div", { className: "_kb_editorbar" },
              React.createElement("span", { className: "_kb_fileicon" }, note?.image ? "▧" : "✦"),
            titleEditing ? React.createElement("input", {
              className: "_kb_filename _kb_titleinput",
              ref: titleInputRef,
              value: titleValue,
              onChange: (event) => setTitleValue(event.target.value),
              onBlur: () => finishTitleEdit(),
              onKeyDown: (event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  finishTitleEdit(true);
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  event.currentTarget.blur();
                }
              },
              "aria-label": "修改笔记名称"
            }) : note && !note.image ? React.createElement("button", {
              className: "_kb_filename _kb_titlebutton",
              type: "button",
              onClick: beginTitleEdit,
              title: "点击修改笔记名称"
            }, note.name) : React.createElement("span", { className: "_kb_filename" }, note?.name || "选择一篇笔记")),
          React.createElement("div", { className: "_kb_editor" },
            metaError && React.createElement("div", { className: "_kb_error" }, metaError),
            !note && !metaError && React.createElement("div", { className: "_kb_empty" }, "从左侧选择一篇 Markdown 笔记"),
            note?.image && React.createElement("img", { className: "_kb_image", src: `${API}/asset?path=${encodeURIComponent(note.path)}`, alt: note.name }),
            note && !note.image && React.createElement(LiveMarkdownEditor, { markdown: editor, onChange: setEditor })),
          React.createElement("div", { className: "_kb_status" }, React.createElement("span", null, status), React.createElement("span", null, note?.path || ""))),
        React.createElement(ResizeHandle, { side: "right", dragging: drag?.side === "right", onPointerDown: startResize }),
        React.createElement(ChatPanel, { sessions, workspaces, modelDirectories, notePath: note?.path, noteContent: note?.image ? null : editor, insertRequest: chatInsertRequest }),
        contextMenu && React.createElement("div", {
          className: "_kb_contextmenu",
          style: { left: contextMenu.x, top: contextMenu.y },
          onPointerDown: (event) => event.stopPropagation(),
          onClick: (event) => event.stopPropagation(),
          onContextMenu: (event) => event.preventDefault()
        },
          React.createElement("button", { className: "_kb_contextitem", type: "button", onClick: () => openNameDialog("note", contextMenu.parent) }, "新建笔记"),
          React.createElement("button", { className: "_kb_contextitem", type: "button", onClick: () => openNameDialog("folder", contextMenu.parent) }, "新建文件夹"),
          contextMenu.entry && React.createElement("div", { className: "_kb_contextsep" }),
          contextMenu.entry && React.createElement("button", { className: "_kb_contextitem", type: "button", onClick: () => addToChat(contextMenu.entry) }, "加入对话"),
          contextMenu.entry && React.createElement("div", { className: "_kb_contextsep" }),
          contextMenu.entry && React.createElement("button", { className: "_kb_contextitem", type: "button", onClick: () => startMove(contextMenu.entry) }, "移动到…"),
          React.createElement("div", { className: "_kb_contextsep" }),
          contextMenu.entry && React.createElement("button", { className: "_kb_contextitem", type: "button", onClick: () => openRenameDialog(contextMenu.entry) }, "重命名"),
          contextMenu.entry && React.createElement("button", { className: "_kb_contextitem", "data-danger": true, type: "button", onClick: () => askDelete(contextMenu.entry) }, "删除")),
        nameDialog && React.createElement("div", { className: "_kb_dialogbackdrop", onPointerDown: () => setNameDialog(null) },
          React.createElement("form", { className: "_kb_dialog", onSubmit: submitName, onPointerDown: (event) => event.stopPropagation() },
            React.createElement("div", { className: "_kb_dialogtitle" }, nameDialog.kind === "folder" ? "新建文件夹" : nameDialog.kind === "note" ? "新建笔记" : "重命名"),
            React.createElement("input", {
              className: "_kb_dialoginput",
              autoFocus: true,
              value: nameValue,
              onChange: (event) => setNameValue(event.target.value),
              onKeyDown: (event) => { if (event.key === "Escape") { event.preventDefault(); setNameDialog(null); } }
            }),
            React.createElement("div", { className: "_kb_dialogactions" },
              React.createElement("button", { className: "_kb_dialogbutton", type: "button", onClick: () => setNameDialog(null) }, "取消"),
              React.createElement("button", { className: "_kb_dialogbutton", type: "submit", "data-primary": true }, "创建")))),
        deleteDialog && React.createElement("div", { className: "_kb_dialogbackdrop", onPointerDown: () => setDeleteDialog(null) },
          React.createElement("div", { className: "_kb_dialog", onPointerDown: (event) => event.stopPropagation() },
            React.createElement("div", { className: "_kb_dialogtitle" }, `删除「${deleteDialog.name}」？`),
            React.createElement("div", { className: "_kb_dialogcopy" }, deleteDialog.kind === "directory" ? "文件夹中的内容会一起移入回收站，可在删除后立即撤销。" : "文件会移入回收站，可在删除后立即撤销。"),
            React.createElement("div", { className: "_kb_dialogactions" },
              React.createElement("button", { className: "_kb_dialogbutton", type: "button", onClick: () => setDeleteDialog(null) }, "取消"),
              React.createElement("button", { className: "_kb_dialogbutton", "data-danger": true, type: "button", onClick: confirmDelete }, "删除")))));
    }

    function ObsidianIcon({ idPrefix = "obsidian" }) {
      const svg = `
        <defs>
          <radialGradient id="${idPrefix}-bottom-left" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="matrix(-59 -225 150 -39 161.4 470)">
            <stop offset="0" stop-color="#fff" stop-opacity=".4"/><stop offset="1" stop-opacity=".1"/>
          </radialGradient>
          <radialGradient id="${idPrefix}-top-right" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="matrix(50 -379 280 37 360 374.2)">
            <stop offset="0" stop-color="#fff" stop-opacity=".6"/><stop offset="1" stop-color="#fff" stop-opacity=".1"/>
          </radialGradient>
          <radialGradient id="${idPrefix}-top-left" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="matrix(69 -319 218 47 175.4 307)">
            <stop offset="0" stop-color="#fff" stop-opacity=".8"/><stop offset="1" stop-color="#fff" stop-opacity=".4"/>
          </radialGradient>
          <radialGradient id="${idPrefix}-bottom-right" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="matrix(-96 -163 187 -111 335.3 512.2)">
            <stop offset="0" stop-color="#fff" stop-opacity=".3"/><stop offset="1" stop-opacity=".3"/>
          </radialGradient>
          <radialGradient id="${idPrefix}-top-edge" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="matrix(-36 166 -112 -24 310 128.2)">
            <stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity=".2"/>
          </radialGradient>
          <radialGradient id="${idPrefix}-left-edge" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="matrix(88 89 -190 187 111 220.2)">
            <stop offset="0" stop-color="#fff" stop-opacity=".2"/><stop offset="1" stop-color="#fff" stop-opacity=".4"/>
          </radialGradient>
          <radialGradient id="${idPrefix}-bottom-edge" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="matrix(9 130 -276 20 215 284)">
            <stop offset="0" stop-color="#fff" stop-opacity=".2"/><stop offset="1" stop-color="#fff" stop-opacity=".3"/>
          </radialGradient>
          <radialGradient id="${idPrefix}-middle-edge" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="matrix(-198 -104 327 -623 400 399.2)">
            <stop offset="0" stop-color="#fff" stop-opacity=".2"/><stop offset=".5" stop-color="#fff" stop-opacity=".2"/><stop offset="1" stop-color="#fff" stop-opacity=".3"/>
          </radialGradient>
          <clipPath id="${idPrefix}-clip"><path d="M.2.2h512v512H.2z"/></clipPath>
        </defs>
        <g clip-path="url(#${idPrefix}-clip)">
          <path d="M382.3 475.6c-3.1 23.4-26 41.6-48.7 35.3-32.4-8.9-69.9-22.8-103.6-25.4l-51.7-4a34 34 0 0 1-22-10.2l-89-91.7a34 34 0 0 1-6.7-37.7s55-121 57.1-127.3c2-6.3 9.6-61.2 14-90.6 1.2-7.9 5-15 11-20.3L248 8.9a34.1 34.1 0 0 1 49.6 4.3L386 125.6a37 37 0 0 1 7.6 22.4c0 21.3 1.8 65 13.6 93.2 11.5 27.3 32.5 57 43.5 71.5a17.3 17.3 0 0 1 1.3 19.2 1494 1494 0 0 1-44.8 70.6c-15 22.3-21.9 49.9-25 73.1z" fill="#6c31e3"/>
          <path d="M165.9 478.3c41.4-84 40.2-144.2 22.6-187-16.2-39.6-46.3-64.5-70-80-.6 2.3-1.3 4.4-2.2 6.5L60.6 342a34 34 0 0 0 6.6 37.7l89.1 91.7a34 34 0 0 0 9.6 7z" fill="url(#${idPrefix}-bottom-left)"/>
          <path d="M278.4 307.8c11.2 1.2 22.2 3.6 32.8 7.6 34 12.7 65 41.2 90.5 96.3 1.8-3.1 3.6-6.2 5.6-9.2a1536 1536 0 0 0 44.8-70.6 17 17 0 0 0-1.3-19.2c-11-14.6-32-44.2-43.5-71.5-11.8-28.2-13.5-72-13.6-93.2 0-8.1-2.6-16-7.6-22.4L297.6 13.2a34 34 0 0 0-1.5-1.7 96 96 0 0 1 2 54 198.3 198.3 0 0 1-17.6 41.3l-7.2 14.2a171 171 0 0 0-19.4 71c-1.2 29.4 4.8 66.4 24.5 115.8z" fill="url(#${idPrefix}-top-right)"/>
          <path d="M278.4 307.8c-19.7-49.4-25.8-86.4-24.5-115.9a171 171 0 0 1 19.4-71c2.3-4.8 4.8-9.5 7.2-14.1 7.1-13.9 14-27 17.6-41.4a96 96 0 0 0-2-54A34.1 34.1 0 0 0 248 9l-105.4 94.8a34.1 34.1 0 0 0-10.9 20.3l-12.8 85-.5 2.3c23.8 15.5 54 40.4 70.1 80a147 147 0 0 1 7.8 24.8c28-6.8 55.7-11 82.1-8.3z" fill="url(#${idPrefix}-top-left)"/>
          <path d="M333.6 511c22.7 6.2 45.6-12 48.7-35.4a187 187 0 0 1 19.4-63.9c-25.6-55-56.5-83.6-90.4-96.3-36-13.4-75.2-9-115 .7 8.9 40.4 3.6 93.3-30.4 162.2 4 1.8 8.1 3 12.5 3.3 0 0 24.4 2 53.6 4.1 29 2 72.4 17.1 101.6 25.2z" fill="url(#${idPrefix}-bottom-right)"/>
          <g clip-rule="evenodd" fill-rule="evenodd">
            <path d="M254.1 190c-1.3 29.2 2.4 62.8 22.1 112.1l-6.2-.5c-17.7-51.5-21.5-78-20.2-107.6a174.7 174.7 0 0 1 20.4-72c2.4-4.9 8-14.1 10.5-18.8 7.1-13.7 11.9-21 16-33.6 5.7-17.5 4.5-25.9 3.8-34.1 4.6 29.9-12.7 56-25.7 82.4a177.1 177.1 0 0 0-20.7 72z" fill="url(#${idPrefix}-top-edge)"/>
            <path d="M194.3 293.4c2.4 5.4 4.6 9.8 6 16.5L195 311c-2.1-7.8-3.8-13.4-6.8-20-17.8-42-46.3-63.6-69.7-79.5 28.2 15.2 57.2 39 75.7 81.9z" fill="url(#${idPrefix}-left-edge)"/>
            <path d="M200.6 315.1c9.8 46-1.2 104.2-33.6 160.9 27.1-56.2 40.2-110.1 29.3-160z" fill="url(#${idPrefix}-bottom-edge)"/>
            <path d="M312.5 311c53.1 19.9 73.6 63.6 88.9 100-19-38.1-45.2-80.3-90.8-96-34.8-11.8-64.1-10.4-114.3 1l-1.1-5c53.2-12.1 81-13.5 117.3 0z" fill="url(#${idPrefix}-middle-edge)"/>
          </g>
        </g>`;
      return React.createElement("svg", {
        className: "_kb_obsidianicon",
        viewBox: "0 0 512 512",
        fill: "none",
        "aria-hidden": true,
        dangerouslySetInnerHTML: { __html: svg }
      });
    }

    function Launcher({ wide, sessions, workspaces, modelDirectories }) {
      const [open, setOpen] = useState(false);
      // 槽主（ui-sidebar）把 `wide` 作为 owner prop 传进来；拿不到时按宽态渲染，
      // 保证「知识中心」这几个字一定看得见（这是用户的明确要求）。
      const showLabel = wide !== false;
      // 槽的几何由 DSH Desktop ≥2.0.11 的 sidebar-footer-styles 决定：`sidebar.footer.action`
      // 被改成「居中列」（flex-direction:column + align-items:center），它不再拉伸子元素，
      // 所以启动器必须自己占满槽宽，否则会被缩成内容宽并顶到侧边栏中间（与 插件市场 / 设置 行不齐）。
      // 这里让外层撑满并居中兜底：宽态由 _kb_trigger 自己的 `100% + 8px / margin -4px`
      // 出血对齐（图标 x 与插件市场一致），rail 态圆钮仍居中。
      return React.createElement("div", { style: { position: "relative", width: "100%", display: "flex", justifyContent: "center" } },
        React.createElement("button", {
          className: "_kb_trigger",
          type: "button",
          "data-on": open ? "true" : "false",
          "data-rail": showLabel ? "false" : "true",
          "aria-label": "知识中心",
          "aria-haspopup": "dialog",
          "aria-expanded": open,
          title: "知识中心",
          onClick: () => setOpen((value) => !value)
        },
        React.createElement(ObsidianIcon, { idPrefix: "launcher" }),
        showLabel && React.createElement("span", { className: "_kb_trigger-label" }, "知识中心")),
        open && React.createElement(Workbench, { sessions, workspaces, modelDirectories, onClose: () => setOpen(false) }));
    }

    const inject = ["slots", "sessions", "workspaces", "conversation", "modelDirectories"];
    function apply(ctx) {
      const slots = ctx.get("slots");
      const sessions = ctx.get("sessions");
      const workspaces = ctx.get("workspaces");
      const modelDirectories = ctx.get("modelDirectories");
      if (slots === undefined || sessions === undefined) return;
      ctx.slots.inject("sidebar.footer.action", () => slots.register({
        name: "sidebar.footer.action",
        id: "dsh-kb"
      }, (ownerProps) => React.createElement(Launcher, {
        // 槽主把 wide 作为 owner prop 传进来（与 cardian 同机制）
        wide: ownerProps?.wide,
        sessions,
        workspaces,
        modelDirectories
      })));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
