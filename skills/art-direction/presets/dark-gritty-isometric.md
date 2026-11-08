---
version: "1"
world: Your world
preset: dark-gritty-isometric
axes:
  rendering: stylised-3d
  realism: clearly stylised, original fictional forms
  proportions: readable silhouettes with expressive heads
  outline:
    weight: none
    colour: "{outline}"
  shading: cel-2-3-tone
  detailDensity: medium
  texture: weathered surfaces with restrained fine grain
  lightingKey: low-key directional light, isometric camera
tone:
  audience: teen
  moodRange:
    - somber
    - tense
    - mildly eerie
  contentLimits:
    - no graphic violence
    - no sexual content
    - no hateful imagery
anchors:
  positive: []
  negative: []
colorRule: full
tokens:
  palette:
    ink:
      $type: color
      $value:
        colorSpace: srgb
        components:
          - 0.1607843137254902
          - 0.1411764705882353
          - 0.2
    warm:
      $type: color
      $value:
        colorSpace: srgb
        components:
          - 0.7686274509803922
          - 0.6078431372549019
          - 0.4392156862745098
    cool:
      $type: color
      $value:
        colorSpace: srgb
        components:
          - 0.48627450980392156
          - 0.5764705882352941
          - 0.6588235294117647
  light:
    $type: color
    $value:
      colorSpace: srgb
      components:
        - 1
        - 0.9411764705882353
        - 0.8392156862745098
  rim:
    $type: color
    $value:
      colorSpace: srgb
      components:
        - 0.6509803921568628
        - 0.7686274509803922
        - 0.9098039215686274
  fog:
    colour:
      $type: color
      $value:
        colorSpace: srgb
        components:
          - 0.6313725490196078
          - 0.6666666666666666
          - 0.7411764705882353
    density:
      $type: number
      $value: 0.1
  valueRange:
    min:
      $type: number
      $value: 0.05
    max:
      $type: number
      $value: 0.65
  saturation:
    min:
      $type: number
      $value: 0.1
    max:
      $type: number
      $value: 0.5
  outline:
    $type: color
    $value:
      colorSpace: srgb
      components:
        - 0.1607843137254902
        - 0.1411764705882353
        - 0.2
adjustable:
  mood:
    - somber
    - tense
    - mildly eerie
identities: {}
---

# dark-gritty-isometric

A starting art constitution; replace world, anchors and identity locks with your own original work.

## Do's and Don'ts

Do use descriptive visual language and the positive anchors. Don't copy negative anchors or violate content limits.
