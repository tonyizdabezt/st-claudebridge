/** @type {{ id: number, message: string }[]} */
const notices = [];
let lastId = 0;
const MAX_NOTICES = 20;

export function pushNotice(message) {
    notices.push({ id: ++lastId, message });
    if (notices.length > MAX_NOTICES) notices.shift();
}

export function recentNotices() {
    return { lastId, notices };
}
