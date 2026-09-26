// Tiny separate Zustand store for the agent chat drawer.
// Kept apart from the foundation store (@/lib/store) so this UI-shell task can
// own it without modifying foundation. AgentsPanel (task 6-c) and the
// AgentChatDrawer both consume it: AgentsPanel calls openChat(id), page.tsx
// reads chatAgentId to mount the drawer.
import { create } from "zustand";

interface ChatState {
  chatAgentId: string | null;
  openChat: (id: string) => void;
  closeChat: () => void;
}

export const useChatStore = create<ChatState>((set) => ({
  chatAgentId: null,
  openChat: (id) => set({ chatAgentId: id }),
  closeChat: () => set({ chatAgentId: null }),
}));
