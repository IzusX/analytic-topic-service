<script setup lang="ts">
import { RouterLink, useRoute } from 'vue-router'
import { navigation } from '../router/navigation'
import SearchIcon from '../features/search/SearchIcon.vue'

const route = useRoute()
</script>

<template>
  <header class="app-header">
    <nav class="header-inner" aria-label="Основная навигация">
      <RouterLink class="brand" :to="{ name: 'search' }"><span class="brand-mark"><SearchIcon name="analytics" /></span><span>Аналитика тем</span></RouterLink>
      <RouterLink v-for="item in navigation" :key="item.routeName" class="nav-link" :to="{ name: item.routeName }" :aria-current="route.name === item.routeName ? 'page' : undefined">
        <SearchIcon name="search" />{{ item.label }}
      </RouterLink>
    </nav>
  </header>
</template>

<style scoped>
.app-header { border-bottom: 1px solid var(--app-header-border); background: var(--app-header); }
.header-inner { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 32px; width: 100%; max-width: 1408px; min-height: 76px; margin-inline: auto; padding: 12px 32px; }
.brand, .nav-link { display: inline-flex; min-height: 44px; align-items: center; gap: 10px; text-decoration: none; }
.brand { color: var(--app-text); font-size: 18px; font-weight: 650; letter-spacing: -0.02em; }
.brand-mark { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 10px; background: var(--app-accent); color: var(--app-page); }
.brand-mark :deep(svg) { width: 24px; height: 24px; }
.nav-link { padding: 8px 14px; border-radius: var(--app-radius-control); color: var(--app-text); font-size: 14px; font-weight: 500; }
.nav-link[aria-current="page"] { background: var(--app-header-active); color: var(--app-accent); text-decoration: underline; text-decoration-thickness: 2px; }
@media (hover: hover) { .brand:hover { color: var(--app-accent-hover); } .nav-link:hover { background: var(--app-header-active); color: var(--app-accent-hover); } }
@media (max-width: 639px) { .header-inner { padding: 10px 16px; gap: 6px 16px; } .brand { font-size: 16px; } .nav-link { padding-inline: 10px; } }
</style>
