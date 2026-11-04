<script setup lang="ts">
import { RouterLink } from 'vue-router'
</script>

<template>
  <section aria-labelledby="page-title">
    <h1 id="page-title" class="page-title" tabindex="-1">Страница не найдена</h1>
    <p class="page-description">Такого адреса в сервисе нет. Откройте поиск, чтобы продолжить.</p>
    <RouterLink class="text-action mt-4" :to="{ name: 'search' }">К поиску</RouterLink>
  </section>
</template>
