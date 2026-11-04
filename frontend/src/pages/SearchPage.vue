<script setup lang="ts">
import { NEmpty } from 'naive-ui'
</script>

<template>
  <section aria-labelledby="page-title">
    <h1 id="page-title" class="page-title" tabindex="-1">Поиск видео</h1>
    <p class="page-description">Исследуйте темы через видео, затем изучайте выборку их каналов.</p>
    <section class="empty-surface" aria-labelledby="search-placeholder-title">
      <h2 id="search-placeholder-title">Поиск ещё не подключён</h2>
      <NEmpty :show-icon="false" description="Здесь появятся запрос, фильтры и найденные видео." />
    </section>
  </section>
</template>
