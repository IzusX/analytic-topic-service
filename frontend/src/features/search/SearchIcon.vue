<script setup lang="ts">
defineProps<{ name: 'search' | 'filters' | 'refresh' | 'info' | 'analytics' | 'external' | 'back' | 'video' }>()
</script>

<template>
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    <template v-if="name === 'search'"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" /></template>
    <template v-else-if="name === 'filters'"><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="2" /><circle cx="15" cy="17" r="2" /></template>
    <template v-else-if="name === 'refresh'"><path d="M20 7v5h-5M4 17v-5h5M6 8a7 7 0 0 1 12-2l2 2M4 16l2 2a7 7 0 0 0 12-2" /></template>
    <template v-else-if="name === 'analytics'"><path d="M4 20V10M10 20V4M16 20v-7M3 20h18" /></template>
    <template v-else-if="name === 'external'"><path d="M14 4h6v6M20 4l-9 9M10 5H5a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1v-5" /></template>
    <template v-else-if="name === 'back'"><path d="m10 5-7 7 7 7M3 12h18" /></template>
    <template v-else-if="name === 'video'"><rect x="3" y="5" width="18" height="14" rx="3" /><path d="m10 9 5 3-5 3Z" /></template>
    <template v-else><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7h.01" /></template>
  </svg>
</template>
