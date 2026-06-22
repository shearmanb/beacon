"use server";

import { revalidatePath } from "next/cache";
import type { ScheduleRule } from "@beacon/shared";
import { getStore } from "../lib/store";

export async function saveSchedule(id: string, label: string, rules: ScheduleRule[]): Promise<void> {
  const store = await getStore();
  const trimmed = id.trim();
  if (!trimmed || rules.length === 0) return;
  await store.schedules.upsert(trimmed, { label: label.trim() || trimmed, rules });
  revalidatePath("/schedules");
  revalidatePath("/");
}

export async function deleteSchedule(id: string): Promise<void> {
  const store = await getStore();
  await store.schedules.remove(id);
  revalidatePath("/schedules");
  revalidatePath("/");
}

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

export async function setSchedule(siteId: string, schedule: string): Promise<void> {
  const store = await getStore();
  const site = await store.sites.get(siteId);
  if (!site) return;
  await store.sites.upsert({ ...site.definition, schedule });
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
