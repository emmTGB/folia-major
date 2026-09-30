// src/services/coverObjectUrls.ts
// Only the cover cache registers URLs created in this renderer; foreign URLs are never revoked.

const ownedCoverUrls = new Map<string, number>();

export const registerCoverObjectUrl = (url: string | null): string | null => {
    if (url?.startsWith('blob:') && !ownedCoverUrls.has(url)) ownedCoverUrls.set(url, 0);
    return url;
};

export const discardCoverObjectUrl = (url: string | null | undefined): void => {
    if (!url || ownedCoverUrls.get(url) !== 0) return;
    ownedCoverUrls.delete(url);
    URL.revokeObjectURL(url);
};

// 先接管新资源再放下旧资源；延至微任务释放，允许过渡取消时同步恢复旧封面。
export const createCoverObjectUrlOwner = () => {
    let held = new Set<string>();
    return (urls: readonly (string | null | undefined)[]): void => {
        const next = new Set(urls.filter((url): url is string => !!url && ownedCoverUrls.has(url)));
        for (const url of next) {
            if (!held.has(url)) ownedCoverUrls.set(url, ownedCoverUrls.get(url)! + 1);
        }
        for (const url of held) {
            if (next.has(url)) continue;
            const count = ownedCoverUrls.get(url);
            if (count === undefined) continue;
            ownedCoverUrls.set(url, count - 1);
            if (count === 1) queueMicrotask(() => discardCoverObjectUrl(url));
        }
        held = next;
    };
};

// 保留 ref.current 接口，使 Stage、窗口交接和队列调用方共享相同的快照所有权。
export const createCoverSnapshotRef = <T extends { cachedCoverUrl: string | null }>() => {
    const own = createCoverObjectUrlOwner();
    let snapshot: T | null = null;
    return {
        get current(): T | null { return snapshot; },
        set current(next: T | null) {
            own([next?.cachedCoverUrl]);
            snapshot = next;
        },
    };
};
