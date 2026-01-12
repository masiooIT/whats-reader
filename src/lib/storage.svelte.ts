/**
 * Persistent storage for chat data using IndexedDB
 * Allows PWA users to keep their imported chats across sessions
 */

import { browser } from '$app/environment';
import type { ChatMessage } from './parser/chat-parser';
import type { MediaFile, ParsedZipChat, FlatItem, SerializedSearchMessage } from './parser/zip-parser';

// Database configuration
const DB_NAME = 'whatsapp-reader';
const DB_VERSION = 1;
const STORE_CHATS = 'chats';
const STORE_MEDIA = 'media';
const STORE_METADATA = 'metadata';

// Serializable chat structure (without functions and non-serializable objects)
interface StoredChat {
	id: string;
	title: string;
	messages: StoredMessage[];
	participants: string[];
	mediaFiles: StoredMediaFile[];
	hasMedia: boolean;
	createdAt: string;
	// Original ParsedChat metadata
	startDate: string | null;
	endDate: string | null;
	messageCount: number;
	mediaCount: number;
	// Pre-computed data for fast loading
	messageIndex?: [string, number][];
	flatItems?: FlatItem[];
	serializedMessages?: SerializedSearchMessage[];
}

// Serializable message structure
interface StoredMessage {
	id: string;
	timestamp: string;
	sender: string;
	content: string;
	isSystemMessage: boolean;
	isMediaMessage: boolean;
	mediaType?: string;
	rawLine: string;
	mediaFileName?: string;
}

// Serializable media file structure (without blob/url/zipEntry)
interface StoredMediaFile {
	name: string;
	path: string;
	type: 'image' | 'video' | 'audio' | 'document' | 'other';
	size: number;
	messageId?: string;
	messageTimestamp?: string;
	messageSender?: string;
}

// Media blob stored separately for efficient retrieval
interface StoredMediaBlob {
	chatId: string;
	path: string;
	blob: Blob;
	mimeType: string;
}

// Storage state
let db: IDBDatabase | null = null;
let isInitialized = $state(false);
let isLoading = $state(false);
let storageError = $state<string | null>(null);
let savedChatCount = $state(0);

/**
 * Initialize IndexedDB database
 */
async function initDB(): Promise<IDBDatabase> {
	if (db) return db;
	if (!browser) throw new Error('IndexedDB is only available in browser');

	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION);

		request.onerror = () => {
			storageError = 'Failed to open database';
			reject(request.error);
		};

		request.onsuccess = () => {
			db = request.result;
			isInitialized = true;
			resolve(db);
		};

		request.onupgradeneeded = (event) => {
			const database = (event.target as IDBOpenDBRequest).result;

			// Create chats store
			if (!database.objectStoreNames.contains(STORE_CHATS)) {
				const chatStore = database.createObjectStore(STORE_CHATS, { keyPath: 'id' });
				chatStore.createIndex('title', 'title', { unique: false });
				chatStore.createIndex('createdAt', 'createdAt', { unique: false });
			}

			// Create media store (blobs stored separately for memory efficiency)
			if (!database.objectStoreNames.contains(STORE_MEDIA)) {
				const mediaStore = database.createObjectStore(STORE_MEDIA, { keyPath: ['chatId', 'path'] });
				mediaStore.createIndex('chatId', 'chatId', { unique: false });
			}

			// Create metadata store for app-level settings
			if (!database.objectStoreNames.contains(STORE_METADATA)) {
				database.createObjectStore(STORE_METADATA, { keyPath: 'key' });
			}
		};
	});
}

/**
 * Generate a unique ID for a chat based on its content
 */
export function generateChatId(chat: ParsedZipChat): string {
	// Use title + first message timestamp + message count for a relatively unique ID
	const firstMsgTime = chat.messages[0]?.timestamp?.toISOString() ?? 'unknown';
	const msgCount = chat.messages.length;
	return `${chat.title}-${firstMsgTime}-${msgCount}`.replace(/[^a-zA-Z0-9-]/g, '_');
}

/**
 * Serialize flat items for storage (create plain objects without any potential prototypes)
 */
function serializeFlatItems(flatItems?: FlatItem[]): FlatItem[] | undefined {
	if (!flatItems) return undefined;
	return flatItems.map((item) => {
		if (item.type === 'date') {
			return { type: 'date' as const, dateKey: item.dateKey };
		}
		return { type: 'message' as const, messageId: item.messageId };
	});
}

/**
 * Serialize messages for storage (create plain objects without any potential prototypes)
 */
function serializeSearchMessages(messages?: SerializedSearchMessage[]): SerializedSearchMessage[] | undefined {
	if (!messages) return undefined;
	return messages.map((msg) => ({
		id: msg.id,
		timestamp: msg.timestamp,
		sender: msg.sender,
		content: msg.content,
		isSystemMessage: msg.isSystemMessage,
		isMediaMessage: msg.isMediaMessage,
		mediaType: msg.mediaType,
		rawLine: msg.rawLine,
	}));
}

/**
 * Convert a ParsedZipChat to a storable format
 */
function chatToStorable(chat: ParsedZipChat): StoredChat {
	const messages: StoredMessage[] = chat.messages.map((msg) => ({
		id: msg.id,
		timestamp: msg.timestamp.toISOString(),
		sender: msg.sender,
		content: msg.content,
		isSystemMessage: msg.isSystemMessage,
		isMediaMessage: msg.isMediaMessage,
		mediaType: msg.mediaType,
		rawLine: msg.rawLine,
		mediaFileName: (msg as ChatMessage & { mediaFile?: MediaFile }).mediaFile?.name,
	}));

	const mediaFiles: StoredMediaFile[] = chat.mediaFiles.map((media) => ({
		name: media.name,
		path: media.path,
		type: media.type,
		size: media.size,
		messageId: media.messageId,
		messageTimestamp: media.messageTimestamp,
		messageSender: media.messageSender,
	}));

	// Explicitly copy participants array to avoid any proxy/reactive objects
	const participants = [...chat.participants];

	return {
		id: generateChatId(chat),
		title: chat.title,
		messages,
		participants,
		mediaFiles,
		hasMedia: chat.hasMedia,
		createdAt: new Date().toISOString(),
		startDate: chat.startDate?.toISOString() ?? null,
		endDate: chat.endDate?.toISOString() ?? null,
		messageCount: chat.messageCount,
		mediaCount: chat.mediaCount,
		messageIndex: chat.messageIndex ? Array.from(chat.messageIndex.entries()) : undefined,
		flatItems: serializeFlatItems(chat.flatItems),
		serializedMessages: serializeSearchMessages(chat.serializedMessages),
	};
}

/**
 * Convert stored chat back to ParsedZipChat format
 */
function storableToChat(stored: StoredChat, mediaBlobs: Map<string, Blob>): ParsedZipChat {
	// Rebuild media files with blobs
	const mediaFiles: MediaFile[] = stored.mediaFiles.map((media) => {
		const blob = mediaBlobs.get(media.path);
		return {
			name: media.name,
			path: media.path,
			type: media.type,
			size: media.size,
			messageId: media.messageId,
			messageTimestamp: media.messageTimestamp,
			messageSender: media.messageSender,
			blob,
			url: blob ? URL.createObjectURL(blob) : undefined,
			_loaded: !!blob,
		};
	});

	// Create media lookup map
	const mediaByName = new Map<string, MediaFile>();
	for (const media of mediaFiles) {
		mediaByName.set(media.name.toLowerCase(), media);
	}

	// Rebuild messages with Date objects and media file references
	const messages: ChatMessage[] = stored.messages.map((msg) => {
		const mediaFile = msg.mediaFileName 
			? mediaByName.get(msg.mediaFileName.toLowerCase()) 
			: undefined;
		return {
			id: msg.id,
			timestamp: new Date(msg.timestamp),
			sender: msg.sender,
			content: msg.content,
			isSystemMessage: msg.isSystemMessage,
			isMediaMessage: msg.isMediaMessage,
			mediaType: msg.mediaType,
			rawLine: msg.rawLine,
			mediaFile,
		} as ChatMessage & { mediaFile?: MediaFile };
	});

	// Rebuild messagesById map
	const messagesById = new Map<string, ChatMessage>();
	for (const msg of messages) {
		messagesById.set(msg.id, msg);
	}

	return {
		title: stored.title,
		messages,
		participants: stored.participants,
		startDate: stored.startDate ? new Date(stored.startDate) : null,
		endDate: stored.endDate ? new Date(stored.endDate) : null,
		messageCount: stored.messageCount,
		mediaCount: stored.mediaCount,
		mediaFiles,
		hasMedia: stored.hasMedia,
		contacts: new Map(), // VCF contacts are not persisted
		messageIndex: stored.messageIndex ? new Map(stored.messageIndex) : undefined,
		flatItems: stored.flatItems,
		messagesById,
		serializedMessages: stored.serializedMessages,
	};
}

/**
 * Save a chat and its media to IndexedDB
 */
export async function saveChat(chat: ParsedZipChat): Promise<string> {
	if (!browser) return '';

	try {
		const database = await initDB();
		const storedChat = chatToStorable(chat);

		// Start a transaction for both stores
		const transaction = database.transaction([STORE_CHATS, STORE_MEDIA], 'readwrite');
		const chatStore = transaction.objectStore(STORE_CHATS);
		const mediaStore = transaction.objectStore(STORE_MEDIA);

		// Save chat data
		await new Promise<void>((resolve, reject) => {
			const request = chatStore.put(storedChat);
			request.onerror = () => reject(request.error);
			request.onsuccess = () => resolve();
		});

		// Save media blobs (if loaded)
		for (const media of chat.mediaFiles) {
			if (media.blob) {
				const storedMedia: StoredMediaBlob = {
					chatId: storedChat.id,
					path: media.path,
					blob: media.blob,
					mimeType: media.blob.type,
				};
				await new Promise<void>((resolve, reject) => {
					const request = mediaStore.put(storedMedia);
					request.onerror = () => reject(request.error);
					request.onsuccess = () => resolve();
				});
			}
		}

		await new Promise<void>((resolve, reject) => {
			transaction.oncomplete = () => resolve();
			transaction.onerror = () => reject(transaction.error);
		});

		// Update count
		await updateSavedChatCount();

		return storedChat.id;
	} catch (error) {
		console.error('Failed to save chat:', error);
		storageError = error instanceof Error ? error.message : 'Failed to save chat';
		throw error;
	}
}

/**
 * Load all saved chats from IndexedDB
 */
export async function loadAllChats(): Promise<ParsedZipChat[]> {
	if (!browser) return [];

	isLoading = true;
	storageError = null;

	try {
		const database = await initDB();
		const transaction = database.transaction([STORE_CHATS, STORE_MEDIA], 'readonly');
		const chatStore = transaction.objectStore(STORE_CHATS);
		const mediaStore = transaction.objectStore(STORE_MEDIA);

		// Get all chats
		const storedChats: StoredChat[] = await new Promise((resolve, reject) => {
			const request = chatStore.getAll();
			request.onerror = () => reject(request.error);
			request.onsuccess = () => resolve(request.result);
		});

		// Load each chat with its media
		const chats: ParsedZipChat[] = [];
		for (const storedChat of storedChats) {
			// Get media blobs for this chat
			const mediaBlobs = new Map<string, Blob>();
			const mediaIndex = mediaStore.index('chatId');
			const mediaItems: StoredMediaBlob[] = await new Promise((resolve, reject) => {
				const request = mediaIndex.getAll(storedChat.id);
				request.onerror = () => reject(request.error);
				request.onsuccess = () => resolve(request.result);
			});

			for (const item of mediaItems) {
				mediaBlobs.set(item.path, item.blob);
			}

			// Convert to ParsedZipChat
			const chat = storableToChat(storedChat, mediaBlobs);
			chats.push(chat);
		}

		savedChatCount = chats.length;
		isLoading = false;
		return chats;
	} catch (error) {
		console.error('Failed to load chats:', error);
		storageError = error instanceof Error ? error.message : 'Failed to load chats';
		isLoading = false;
		return [];
	}
}

/**
 * Delete a specific chat from storage
 */
export async function deleteChat(chatId: string): Promise<void> {
	if (!browser) return;

	try {
		const database = await initDB();
		const transaction = database.transaction([STORE_CHATS, STORE_MEDIA], 'readwrite');
		const chatStore = transaction.objectStore(STORE_CHATS);
		const mediaStore = transaction.objectStore(STORE_MEDIA);

		// Delete chat
		await new Promise<void>((resolve, reject) => {
			const request = chatStore.delete(chatId);
			request.onerror = () => reject(request.error);
			request.onsuccess = () => resolve();
		});

		// Delete all media for this chat
		const mediaIndex = mediaStore.index('chatId');
		const mediaKeys: IDBValidKey[] = await new Promise((resolve, reject) => {
			const request = mediaIndex.getAllKeys(chatId);
			request.onerror = () => reject(request.error);
			request.onsuccess = () => resolve(request.result);
		});

		for (const key of mediaKeys) {
			await new Promise<void>((resolve, reject) => {
				const request = mediaStore.delete(key);
				request.onerror = () => reject(request.error);
				request.onsuccess = () => resolve();
			});
		}

		await new Promise<void>((resolve, reject) => {
			transaction.oncomplete = () => resolve();
			transaction.onerror = () => reject(transaction.error);
		});

		await updateSavedChatCount();
	} catch (error) {
		console.error('Failed to delete chat:', error);
		storageError = error instanceof Error ? error.message : 'Failed to delete chat';
		throw error;
	}
}

/**
 * Clear all stored data
 */
export async function clearAllStorage(): Promise<void> {
	if (!browser) return;

	try {
		const database = await initDB();
		const transaction = database.transaction([STORE_CHATS, STORE_MEDIA], 'readwrite');
		const chatStore = transaction.objectStore(STORE_CHATS);
		const mediaStore = transaction.objectStore(STORE_MEDIA);

		await new Promise<void>((resolve, reject) => {
			const request = chatStore.clear();
			request.onerror = () => reject(request.error);
			request.onsuccess = () => resolve();
		});

		await new Promise<void>((resolve, reject) => {
			const request = mediaStore.clear();
			request.onerror = () => reject(request.error);
			request.onsuccess = () => resolve();
		});

		await new Promise<void>((resolve, reject) => {
			transaction.oncomplete = () => resolve();
			transaction.onerror = () => reject(transaction.error);
		});

		savedChatCount = 0;
	} catch (error) {
		console.error('Failed to clear storage:', error);
		storageError = error instanceof Error ? error.message : 'Failed to clear storage';
		throw error;
	}
}

/**
 * Get the count of saved chats
 */
async function updateSavedChatCount(): Promise<void> {
	if (!browser) return;

	try {
		const database = await initDB();
		const transaction = database.transaction(STORE_CHATS, 'readonly');
		const store = transaction.objectStore(STORE_CHATS);

		savedChatCount = await new Promise((resolve, reject) => {
			const request = store.count();
			request.onerror = () => reject(request.error);
			request.onsuccess = () => resolve(request.result);
		});
	} catch {
		savedChatCount = 0;
	}
}

/**
 * Check if storage is available
 */
export function isStorageAvailable(): boolean {
	if (!browser) return false;
	return 'indexedDB' in window;
}

/**
 * Get storage quota info (if available)
 */
export async function getStorageInfo(): Promise<{ used: number; quota: number } | null> {
	if (!browser || !navigator.storage?.estimate) return null;

	try {
		const estimate = await navigator.storage.estimate();
		return {
			used: estimate.usage ?? 0,
			quota: estimate.quota ?? 0,
		};
	} catch {
		return null;
	}
}

/**
 * Create the storage state object with reactive getters
 */
function createStorageState() {
	return {
		get isInitialized() {
			return isInitialized;
		},
		get isLoading() {
			return isLoading;
		},
		get error() {
			return storageError;
		},
		get savedChatCount() {
			return savedChatCount;
		},
		clearError() {
			storageError = null;
		},
	};
}

export const storageState = createStorageState();

/**
 * Initialize storage on app load
 */
export async function initStorage(): Promise<void> {
	if (!browser || !isStorageAvailable()) return;

	try {
		await initDB();
		await updateSavedChatCount();
	} catch (error) {
		console.error('Failed to initialize storage:', error);
		storageError = error instanceof Error ? error.message : 'Failed to initialize storage';
	}
}

/**
 * Save a media file that was loaded after initial import
 * (for lazy-loaded media files)
 */
export async function saveMediaFile(chatTitle: string, messageCount: number, firstMsgTime: string, media: MediaFile): Promise<void> {
	if (!browser || !media.blob) return;

	try {
		const database = await initDB();
		const chatId = `${chatTitle}-${firstMsgTime}-${messageCount}`.replace(/[^a-zA-Z0-9-]/g, '_');

		const transaction = database.transaction(STORE_MEDIA, 'readwrite');
		const mediaStore = transaction.objectStore(STORE_MEDIA);

		const storedMedia: StoredMediaBlob = {
			chatId,
			path: media.path,
			blob: media.blob,
			mimeType: media.blob.type,
		};

		await new Promise<void>((resolve, reject) => {
			const request = mediaStore.put(storedMedia);
			request.onerror = () => reject(request.error);
			request.onsuccess = () => resolve();
		});
	} catch (error) {
		console.error('Failed to save media file:', error);
		// Don't throw - this is a non-critical operation
	}
}
