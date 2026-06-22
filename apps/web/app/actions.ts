"use server";

import { revalidatePath } from "next/cache";
import { getStore } from "../lib/store";

export async function runNow(siteId?: string): Promise<void> {
  const store = await getStore();
  await store.commands.enqueue("run_now", siteId ?? null);
  revalidatePath("/");
}

export async function setMonitoring(siteId: string, enabled: boolean): Promise<void> {
  const store = await getStore();
  await store.sites.setEnabled(siteId, enabled);
  revalidatePath("/");
}

export async function setImminent(siteId: string, imminent: boolean): Promise<void> {
  const store = await getStore();
  await store.commands.enqueue("set_imminent", siteId, { imminent });
  revalidatePath("/");
}

export async function setIgnore(handle: string, ignored: boolean): Promise<void> {
  const store = await getStore();
  if (ignored) await store.ignored.add(handle);
  else await store.ignored.remove(handle);
  revalidatePath("/products");
}

export async function addReminder(input: {
  date: string;
  time: string;
  text: string;
  priority: boolean;
}): Promise<void> {
  const store = await getStore();
  if (!input.date || !input.text.trim()) return;
  await store.reminders.add({
    id: `r_${Date.now()}`,
    date: input.date,
    time: input.time || null,
    text: input.text.trim(),
    priority: input.priority,
  });
  revalidatePath("/reminders");
}

export async function setReminderDone(id: string, done: boolean): Promise<void> {
  const store = await getStore();
  await store.reminders.update(id, { done });
  revalidatePath("/reminders");
}

export async function removeReminder(id: string): Promise<void> {
  const store = await getStore();
  await store.reminders.remove(id);
  revalidatePath("/reminders");
}
