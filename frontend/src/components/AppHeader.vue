<script setup lang="ts">
import { RouterLink, useRoute } from 'vue-router'
import { navigation } from '../router/navigation'

const route = useRoute()
</script>

<template>
  <header class="app-header">
    <nav
      class="mx-auto flex min-h-16 w-full max-w-[1408px] flex-wrap items-center gap-x-8 px-4 sm:px-8"
      aria-label="Основная навигация"
    >
      <RouterLink class="brand" :to="{ name: 'search' }">Аналитика тем</RouterLink>
      <RouterLink
        v-for="item in navigation"
        :key="item.routeName"
        class="nav-link"
        :to="{ name: item.routeName }"
        :aria-current="route.name === item.routeName ? 'page' : undefined"
      >
        {{ item.label }}
      </RouterLink>
    </nav>
  </header>
</template>

<style scoped>
.app-header {
  border-bottom: 1px solid var(--app-divider);
  background: var(--app-page);
}

.brand, .nav-link {
  display: inline-flex;
  min-height: 44px;
  align-items: center;
  text-decoration: none;
}

.brand {
  color: var(--app-text);
  font-weight: 650;
}

.nav-link {
  color: var(--app-muted);
}

.nav-link[aria-current="page"] {
  color: var(--app-accent);
  text-decoration: underline;
  text-decoration-thickness: 2px;
}

.brand:hover, .nav-link:hover {
  color: var(--app-accent-hover);
}
</style>
